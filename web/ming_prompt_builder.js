// SPDX-License-Identifier: GPL-3.0-only
// UX inspired by Kijai's Ideogram4PromptBuilderKJ (ComfyUI-KJNodes, GPL-3.0).
// Ming state, DOM editor, and Python-backed import/export are implemented here independently.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "MingImagePromptBuilder";
const EDITORS = new WeakMap();
const SETTINGS = ["width", "height", "image_style", "ambient_lighting", "bg_brightness", "output_format", "import_json"];
let copiedRegion = null; // Session clipboard only; never a workflow property.

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const uid = () => `layer_${crypto.randomUUID()}`;
const field = (node, name) => node.widgets?.find((widget) => widget.name === name);
const validHex = (value) => /^#[0-9a-f]{6}$/i.test(value);

function element(tag, className = "", text = "") {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
}

// Explicit primitive copies avoid structuredClone(Proxy), reactive arrays, and
// accidental DOM/canvas/drag/selection objects in workflow or PNG metadata.
export function plainRegion(source) {
    const region = {};
    for (const key of ["id", "kind", "text", "description", "relation"]) {
        if (typeof source[key] !== "string") throw new Error(`Region ${key} must be a string.`);
        region[key] = source[key];
    }
    for (const key of ["x", "y", "w", "h"]) {
        if (typeof source[key] !== "number" || !Number.isFinite(source[key])) throw new Error(`Region ${key} must be finite.`);
        region[key] = source[key];
    }
    if (!Array.isArray(source.colors)) throw new Error("Region colors must be an array.");
    region.colors = Array.from(source.colors, (color) => {
        if (typeof color !== "string") throw new Error("Colors must be strings.");
        return color;
    });
    if (typeof source.raw_description === "string") region.raw_description = source.raw_description;
    return region;
}

export function plainState(regions) {
    // Index 0 is the FRONT. Python reverses this array for Ming BACK -> FRONT.
    return { version: 1, order: "front_to_back", regions: Array.from(regions, plainRegion) };
}

function readRegions(value) {
    const state = JSON.parse(value || "[]");
    if (Array.isArray(state)) return Array.from(state, plainRegion);
    if (state.version !== 1 || state.order !== "front_to_back" || !Array.isArray(state.regions)) {
        throw new Error("Unsupported Ming editor state. Expected version 1, front_to_back.");
    }
    return Array.from(state.regions, plainRegion);
}

function chain(object, name, callback) {
    const original = object[name];
    object[name] = function (...args) {
        const result = original?.apply(this, args);
        callback.apply(this, args);
        return result;
    };
}

async function request(operation, payload, signal) {
    const response = await api.fetchApi(`/ming_prompt_builder/${operation}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Ming editor request failed (${response.status}).`);
    return data;
}

class MingEditor {
    constructor(node) {
        this.node = node;
        this.regions = [];
        this.selected = null;
        this.drag = null;
        this.background = null;
        this.backgroundSource = "";
        this.executedBackground = "";
        this.revision = 0;
        this.validationTimer = 0;
        this.paintFrame = 0;
        this.destroyed = false;
        this.loadError = false;
        this.events = new AbortController();
        this.root = element("div", "ming-builder");
        this.root.dataset.captureWheel = "true";
        this.root.tabIndex = -1;
        this.buildUI();
        this.installEvents();
        this.hideWidgets();
        this.widget = node.addDOMWidget("ming_visual_editor", "ming_editor", this.root, {
            serialize: false, hideOnZoom: false, getMinHeight: () => 650,
        });
        this.widget.serialize = false;
        this.widget.options.canvasOnly = false;
        this.resizeObserver = new ResizeObserver(() => this.paint());
        this.resizeObserver.observe(this.stage);

        const dataWidget = field(node, "layers_data");
        // serializeValue is used by graphToPrompt for the execution inputs.
        // .value and onSerialize below always contain ONLY the durable state.
        dataWidget.serializeValue = () => {
            if (this.loadError) return dataWidget.value; // Preserve a damaged workflow for repair.
            this.queuedRevision = this.revision;
            return JSON.stringify({ ...plainState(this.durableRegions()), _preview_selected: this.selected });
        };
        for (const name of SETTINGS) {
            const widget = field(node, name);
            if (!widget) continue;
            const original = widget.callback;
            widget.callback = (...args) => {
                original?.apply(widget, args);
                this.syncSettings();
                this.changed(false);
            };
        }
        chain(node, "onSerialize", (serialized) => this.save(serialized));
        chain(node, "onConfigure", (serialized) => this.restore(serialized));
        chain(node, "onResize", () => {
            if (node.size[0] < 640) node.size[0] = 640;
            this.paint();
        });
        chain(node, "onRemoved", () => this.destroy());
        chain(node, "onConnectionsChange", () => queueMicrotask(() => {
            if (!this.destroyed) { this.syncSettings(); this.refreshBackground(); }
        }));
        chain(node, "onDrawForeground", () => {
            this.refreshBackground();
            const scale = app.canvas.ds.scale;
            if (scale !== this.lastZoom) { this.lastZoom = scale; this.paint(); }
        });
        chain(node, "onExecuted", (output) => this.executed(output));
        this.restore();
    }

    listen(target, type, callback, options = {}) {
        // Global targets need explicit cleanup. Detached inspector rows can be
        // collected normally instead of remaining attached to one long-lived signal.
        const global = target === window || target === document || target === api;
        target.addEventListener(type, callback, global ? { ...options, signal: this.events.signal } : options);
    }

    button(label, action, title = label) {
        const button = element("button", "ming-button", label);
        button.type = "button";
        button.title = title;
        this.listen(button, "click", () => {
            Promise.resolve().then(action).catch((error) => this.error(error));
        });
        return button;
    }

    inputArea(label, value, action, placeholder = "") {
        const group = element("label", "ming-field");
        const heading = element("span", "ming-label", label);
        const input = element("textarea");
        input.value = value;
        input.rows = 2;
        input.placeholder = placeholder;
        input.spellcheck = false;
        input.setAttribute("aria-label", label);
        this.listen(input, "input", () => action(input.value));
        this.listen(input, "change", () => this.notifyGraph());
        group.append(heading, input);
        return { group, input };
    }

    buildUI() {
        const toolbar = element("div", "ming-toolbar");
        const identity = element("div", "ming-identity");
        identity.append(element("strong", "", "MING"), element("span", "", "Design · T2I"));
        toolbar.append(identity, this.button("Copy JSON", () => this.copyJSON()),
            this.button("Import JSON", () => this.jsonDialog()), this.button("Clear", () => this.clear()));
        this.format = element("select");
        this.format.setAttribute("aria-label", "Output format");
        for (const name of ["pretty", "compact"]) {
            const option = element("option", "", name);
            option.value = name;
            this.format.append(option);
        }
        this.listen(this.format, "change", () => this.setSetting("output_format", this.format.value));
        toolbar.append(this.format);

        const settings = element("div", "ming-settings");
        this.style = this.inputArea("Image Style", "", (value) => this.setSetting("image_style", value), "e.g. modern editorial poster");
        this.lighting = this.inputArea("Ambient Lighting", "", (value) => this.setSetting("ambient_lighting", value), "e.g. soft studio lighting");
        settings.append(this.style.group, this.lighting.group);

        const content = element("div", "ming-content");
        const workspace = element("div", "ming-workspace");
        const canvasHeader = element("div", "ming-canvas-header");
        this.dimensions = element("span");
        this.brightness = element("input");
        this.brightness.type = "range";
        this.brightness.min = "0";
        this.brightness.max = "100";
        this.brightness.setAttribute("aria-label", "Background brightness");
        const brightnessLabel = element("label", "ming-brightness", "BG");
        this.brightnessValue = element("span");
        brightnessLabel.append(this.brightness, this.brightnessValue);
        this.listen(this.brightness, "input", () => this.setSetting("bg_brightness", Number(this.brightness.value)));
        this.listen(this.brightness, "change", () => this.notifyGraph());
        canvasHeader.append(this.dimensions, brightnessLabel);
        this.stage = element("div", "ming-stage");
        this.canvas = element("canvas", "ming-canvas");
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute("aria-label", "Ming region canvas");
        this.canvas.title = "Drag to draw · Ctrl/Cmd-drag over existing regions · Alt-click cycles overlaps";
        this.stage.append(this.canvas);
        const help = element("div", "ming-help", "Drag to draw · Ctrl/Cmd-drag over a region · Alt-click cycles overlaps");
        this.layerList = element("div", "ming-layers");
        this.layerList.setAttribute("role", "listbox");
        this.layerList.setAttribute("aria-label", "Layers, front to back");
        const layerHeader = element("div", "ming-layer-header");
        layerHeader.append(element("strong", "", "LAYERS"), element("span", "", "FRONT ↑  ·  ↓ BACK"));
        workspace.append(canvasHeader, this.stage, help, layerHeader, this.layerList);
        this.inspector = element("div", "ming-inspector");
        content.append(workspace, this.inspector);

        this.status = element("div", "ming-status");
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        this.root.append(toolbar, settings, content, this.status);
    }

    hideWidgets() {
        for (const name of [...SETTINGS.filter((name) => !["width", "height"].includes(name)), "layers_data"]) {
            const widget = field(this.node, name);
            if (!widget) continue;
            widget.hidden = true;
            widget.type = "hidden";
            widget.computeSize = () => [0, -4];
            if (widget.element) widget.element.style.display = "none";
            if (widget.inputEl) widget.inputEl.style.display = "none";
        }
    }

    value(name) { return field(this.node, name)?.value; }
    connected(name) { return this.node.inputs?.some((input) => input.name === name && input.link != null); }

    setSetting(name, value) {
        const widget = field(this.node, name);
        if (!widget || this.connected(name)) return;
        widget.value = value;
        this.syncSettings();
        this.changed(false);
    }

    syncSettings() {
        for (const [name, input] of [["image_style", this.style.input], ["ambient_lighting", this.lighting.input],
            ["output_format", this.format], ["bg_brightness", this.brightness]]) {
            if (input !== document.activeElement) input.value = this.value(name);
            input.disabled = this.connected(name);
            input.title = input.disabled ? "Controlled by a connected input; updates after execution." : "";
        }
        const w = Number(this.value("width")), h = Number(this.value("height"));
        const gcd = (a, b) => b ? gcd(b, a % b) : a;
        const divisor = gcd(w, h) || 1;
        this.dimensions.textContent = `${w} × ${h} · ${w / divisor}:${h / divisor}`;
        this.brightnessValue.textContent = `${this.value("bg_brightness")}%`;
        this.paint();
    }

    snapshot() {
        const snapshot = plainState(this.durableRegions());
        snapshot.settings = {};
        for (const name of SETTINGS) {
            const value = this.value(name);
            if (typeof value === "string" || typeof value === "number") snapshot.settings[name] = value;
        }
        return snapshot;
    }

    persist() {
        if (this.loadError) return;
        field(this.node, "layers_data").value = JSON.stringify(plainState(this.durableRegions()));
    }

    durableRegions() { return this.drag ? readRegions(this.drag.before) : this.regions; }

    save(serialized) {
        if (this.loadError) return;
        this.persist();
        serialized.properties ??= {};
        serialized.properties.ming_prompt_builder = this.snapshot();
        // LiteGraph and Vue versions differ in when serializeValue is called.
        // Force the saved widget string to exclude the execution-only selection.
        const index = this.node.widgets.indexOf(field(this.node, "layers_data"));
        if (Array.isArray(serialized.widgets_values)) serialized.widgets_values[index] = field(this.node, "layers_data").value;
    }

    restore(serialized) {
        try {
            const snapshot = serialized?.properties?.ming_prompt_builder;
            this.regions = readRegions(snapshot ? JSON.stringify(snapshot) : this.value("layers_data"));
            if (snapshot?.settings) {
                for (const name of SETTINGS) {
                    if (Object.hasOwn(snapshot.settings, name)) field(this.node, name).value = snapshot.settings[name];
                }
            }
            this.selected = null;
            this.drag = null;
            this.loadError = false;
            this.hideWidgets();
            this.persist();
            this.syncSettings();
            this.renderLayers();
            this.renderInspector();
            this.scheduleValidation();
        } catch (error) {
            this.loadError = true;
            this.error(new Error(`Workflow state could not be loaded: ${error.message} Original data was retained.`));
        }
    }

    notifyGraph() {
        this.node.graph?.change();
        this.node.setDirtyCanvas(true, true);
    }

    changed(rebuild = true) {
        this.revision++;
        this.persist();
        if (rebuild) { this.renderLayers(); this.renderInspector(); }
        this.paint();
        this.scheduleValidation();
    }

    message(text, kind = "info") {
        this.status.textContent = text;
        this.status.dataset.kind = kind;
    }

    error(error) {
        console.error("[MingImagePromptBuilder]", error);
        this.message(error.message || String(error), "error");
    }

    payload() {
        return { width: Number(this.value("width")), height: Number(this.value("height")),
            image_style: this.value("image_style"), ambient_lighting: this.value("ambient_lighting"),
            layers_data: JSON.stringify(plainState(this.durableRegions())), import_json: this.value("import_json") || "",
            output_format: this.value("output_format") };
    }

    scheduleValidation() {
        clearTimeout(this.validationTimer);
        this.validationTimer = setTimeout(() => this.validate(), 400);
    }

    async validate() {
        this.validationRequest?.abort();
        this.validationRequest = new AbortController();
        const revision = this.revision;
        try {
            const result = await request("serialize", this.payload(), this.validationRequest.signal);
            if (revision !== this.revision || this.destroyed) return;
            const warnings = [...result.warnings];
            if (this.value("import_json")?.trim() || this.connected("import_json")) {
                warnings.unshift("import_json overrides the editor on execution. Import into editor to edit locally.");
            }
            this.message(warnings.length ? warnings.join("\n") : `${this.regions.length} regions · Valid Ming prompt · Export order: back → front`, warnings.length ? "warning" : "info");
        } catch (error) {
            if (error.name !== "AbortError" && revision === this.revision && !this.destroyed) this.message(error.message, "error");
        }
    }

    select(id) {
        this.selected = id;
        this.renderLayers();
        this.renderInspector();
        this.paint();
    }

    active() { return this.regions.find((region) => region.id === this.selected); }

    renderLayers() {
        this.layerList.replaceChildren();
        if (!this.regions.length) {
            this.layerList.append(element("p", "ming-empty", "Draw a rectangle to add your first layer."));
            return;
        }
        this.regions.forEach((region, index) => {
            const row = element("div", `ming-layer${region.id === this.selected ? " selected" : ""}`);
            row.dataset.regionId = region.id;
            row.tabIndex = 0;
            row.draggable = true;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(region.id === this.selected));
            row.setAttribute("aria-label", `Layer ${this.regions.length - index}, ${region.kind}`);
            const swatch = element("span", "ming-layer-swatch");
            swatch.style.background = validHex(region.colors[0] || "") ? region.colors[0] : "#8AB4F8";
            const label = element("span", "ming-layer-label", region.kind === "text" ? region.text || "Untitled text" : region.description || "Untitled object");
            row.append(element("span", "ming-drag-grip", "⠿"), swatch,
                element("span", "ming-layer-number", String(this.regions.length - index).padStart(2, "0")),
                element("span", "ming-type", region.kind === "text" ? "TEXT" : "OBJ"), label);
            this.listen(row, "click", () => this.select(region.id));
            this.listen(row, "keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.select(region.id); }
            });
            this.listen(row, "contextmenu", (event) => {
                event.preventDefault(); this.select(region.id); this.contextMenu(event);
            });
            this.listen(row, "dragstart", (event) => {
                this.reorderId = region.id;
                event.dataTransfer.setData("text/plain", region.id);
                event.dataTransfer.effectAllowed = "move";
            });
            this.listen(row, "dragover", (event) => { event.preventDefault(); row.classList.add("drop-target"); });
            this.listen(row, "dragleave", () => row.classList.remove("drop-target"));
            this.listen(row, "drop", (event) => {
                event.preventDefault();
                const from = this.regions.findIndex((r) => r.id === this.reorderId);
                if (from >= 0) this.reorder(from, index);
                this.reorderId = null;
            });
            this.listen(row, "dragend", () => { this.reorderId = null; this.renderLayers(); });
            this.layerList.append(row);
        });
    }

    renderInspector() {
        const scroll = this.inspector.dataset.regionId === this.selected ? this.inspector.scrollTop : 0;
        this.inspector.dataset.regionId = this.selected || "";
        this.inspector.replaceChildren();
        const region = this.active();
        if (!region) {
            this.inspector.append(element("div", "ming-inspector-title", "REGION INSPECTOR"),
                element("p", "ming-empty", "Select a region to describe an object or exact text."),
                element("p", "ming-help", "Delete removes · Ctrl/Cmd+C/V copies and pastes · Ctrl/Cmd+D duplicates"));
            return;
        }
        const header = element("div", "ming-inspector-title", `REGION ${this.regions.length - this.regions.indexOf(region)}`);
        const type = element("div", "ming-type-switch");
        type.setAttribute("aria-label", "Region type");
        for (const name of ["object", "text"]) {
            const button = this.button(name === "object" ? "Object" : "Text", () => {
                if (region.kind === name) return;
                // Switching imported text to Object preserves the full source description.
                if (name === "object" && region.raw_description) region.description = region.raw_description;
                delete region.raw_description;
                region.kind = name;
                this.changed(); this.notifyGraph();
            });
            button.setAttribute("aria-pressed", String(region.kind === name));
            type.append(button);
        }
        this.inspector.append(header, element("span", "ming-label", "Type"), type);
        const updateText = (key, value) => {
            region[key] = value;
            delete region.raw_description;
            this.changed(false); this.renderLayers();
        };
        const description = this.inputArea("Description", region.description, (value) => updateText("description", value),
            region.kind === "text" ? "Visual appearance, typography, material…" : "Describe this visible object or group…");
        this.inspector.append(description.group);
        if (region.kind === "text") {
            const exact = this.inputArea("Exact Text", region.text, (value) => updateText("text", value), "Preserved exactly, including spacing and line breaks");
            this.inspector.append(exact.group);
        }
        const relation = this.inputArea("Hierarchy / Relation", region.relation, (value) => {
            region.relation = value; this.changed(false);
        }, "e.g. primary title above the central subject");
        this.inspector.append(relation.group);
        if (region.raw_description) {
            const note = element("details", "ming-source");
            note.append(element("summary", "", "Imported description preserved"), element("p", "", region.raw_description));
            this.inspector.append(note);
        }
        this.colorEditor = element("div", "ming-colors");
        this.inspector.append(element("span", "ming-label", "Colors"), this.colorEditor);
        this.renderColors(region);

        const geometry = element("div", "ming-geometry");
        for (const key of ["x", "y", "w", "h"]) {
            const label = element("label", "", key.toUpperCase());
            const input = element("input");
            input.type = "number"; input.min = key === "w" || key === "h" ? "0.001" : "0";
            input.max = "1"; input.step = "0.001"; input.value = region[key].toFixed(3);
            input.setAttribute("aria-label", `Normalized ${key}`);
            this.listen(input, "change", () => {
                const value = Number(input.value);
                if (!input.value || !Number.isFinite(value)) { input.value = region[key].toFixed(3); return; }
                if (key === "x" || key === "y") region[key] = clamp(value, 0, 1 - region[key === "x" ? "w" : "h"]);
                else region[key] = clamp(value, 0.001, 1 - region[key === "w" ? "x" : "y"]);
                this.changed(); this.notifyGraph();
            });
            label.append(input); geometry.append(label);
        }
        this.inspector.append(element("span", "ming-label", "Normalized rectangle"), geometry);
        const actions = element("div", "ming-region-actions");
        for (const [label, action] of [["↑ Front", () => this.moveLayer(-1)], ["↓ Back", () => this.moveLayer(1)],
            ["Duplicate", () => this.duplicate()], ["Delete", () => this.remove()]]) actions.append(this.button(label, action));
        this.inspector.append(actions);
        this.inspector.scrollTop = scroll;
    }

    renderColors(region) {
        this.colorEditor.replaceChildren();
        region.colors.forEach((color, index) => {
            const row = element("div", "ming-color-row");
            const picker = element("input");
            picker.type = "color"; picker.value = validHex(color) ? color : "#FFFFFF";
            picker.setAttribute("aria-label", `Color swatch ${index + 1}`);
            const hex = element("input");
            hex.type = "text"; hex.value = color; hex.maxLength = 7;
            hex.setAttribute("aria-label", `Color hex ${index + 1}`);
            hex.pattern = "#[0-9A-Fa-f]{6}";
            const setColor = (value) => {
                region.colors[index] = value.toUpperCase();
                hex.value = region.colors[index];
                hex.setCustomValidity(validHex(value) ? "" : "Use #RRGGBB.");
                if (validHex(value)) picker.value = value;
                this.changed(false); this.renderLayers();
            };
            this.listen(picker, "input", () => setColor(picker.value));
            this.listen(hex, "input", () => setColor(hex.value));
            this.listen(hex, "change", () => this.notifyGraph());
            const remove = this.button("×", () => { region.colors.splice(index, 1); this.changed(); this.notifyGraph(); }, `Remove color ${index + 1}`);
            remove.setAttribute("aria-label", `Remove color ${index + 1}`);
            row.append(picker, hex, remove);
            this.colorEditor.append(row);
        });
        this.colorEditor.append(this.button("+ Color", () => {
            region.colors.push("#FFFFFF"); this.changed(); this.notifyGraph();
        }));
    }

    installEvents() {
        for (const type of ["pointerdown", "mousedown", "dblclick", "wheel", "keydown", "keyup"]) {
            this.listen(this.root, type, (event) => event.stopPropagation());
        }
        this.listen(this.root, "keydown", (event) => this.keydown(event));
        this.listen(this.canvas, "pointerdown", (event) => this.pointerDown(event));
        this.listen(this.canvas, "pointermove", (event) => this.pointerMove(event));
        this.listen(this.canvas, "pointerup", (event) => this.pointerUp(event));
        this.listen(this.canvas, "pointercancel", () => this.cancelDrag());
        this.listen(this.canvas, "lostpointercapture", () => { if (this.drag) this.cancelDrag(); });
        this.listen(this.canvas, "contextmenu", (event) => {
            event.preventDefault();
            const hit = this.hits(this.point(event))[0];
            if (hit) this.select(hit.id);
            this.contextMenu(event);
        });
        this.listen(this.canvas, "dblclick", () => this.inspector.querySelector("textarea")?.focus());
        this.listen(api, "executed", () => this.refreshBackground());
        this.listen(window, "resize", () => this.paint());
    }

    point(event) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
    }

    hits(point) {
        return this.regions.filter((r) => point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h);
    }

    handles(region) {
        const { x, y, w, h } = region;
        return [["nw", x, y], ["n", x + w / 2, y], ["ne", x + w, y], ["e", x + w, y + h / 2],
            ["se", x + w, y + h], ["s", x + w / 2, y + h], ["sw", x, y + h], ["w", x, y + h / 2]];
    }

    handleAt(point) {
        const region = this.active();
        if (!region) return null;
        const rect = this.canvas.getBoundingClientRect();
        return this.handles(region).find(([, x, y]) => Math.abs(point.x - x) * rect.width < 8 && Math.abs(point.y - y) * rect.height < 8)?.[0];
    }

    pointerDown(event) {
        if (event.button !== 0 || this.loadError) return;
        event.preventDefault();
        this.closeMenu();
        this.canvas.focus();
        const point = this.point(event);
        const handle = !event.ctrlKey && !event.metaKey && !event.altKey ? this.handleAt(point) : null;
        const hits = this.hits(point);
        let region = handle ? this.active() : hits[0];
        if (event.altKey && hits.length) {
            const index = hits.findIndex((item) => item.id === this.selected);
            this.select(hits[(index + 1) % hits.length].id);
            return;
        }
        if (event.ctrlKey || event.metaKey) region = null;
        const before = JSON.stringify(plainState(this.regions));
        if (!region) {
            region = { id: uid(), x: point.x, y: point.y, w: 0, h: 0, kind: "object", text: "", description: "", relation: "", colors: [] };
            this.regions.unshift(region); // A new layer starts at the FRONT.
        }
        this.selected = region.id;
        this.drag = { mode: handle || (region.w === 0 ? "draw" : "move"), origin: point, before,
            region: plainRegion(region), pointerId: event.pointerId };
        this.canvas.setPointerCapture(event.pointerId);
        // Rebuilding the inspector mid-gesture can reflow Vue's auto-sized DOM
        // widget. Commit its fields on pointer-up so the coordinate frame stays fixed.
        this.paint();
    }

    pointerMove(event) {
        const point = this.point(event);
        if (!this.drag) {
            const handle = this.handleAt(point);
            this.canvas.style.cursor = handle ? `${handle}-resize` : this.hits(point).length ? "move" : "crosshair";
            return;
        }
        const active = this.active(), { region: start, origin, mode } = this.drag;
        const dx = point.x - origin.x, dy = point.y - origin.y;
        if (mode === "move") {
            active.x = clamp(start.x + dx, 0, 1 - start.w);
            active.y = clamp(start.y + dy, 0, 1 - start.h);
        } else if (mode === "draw") {
            Object.assign(active, { x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), w: Math.abs(dx), h: Math.abs(dy) });
        } else {
            let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
            if (mode.includes("w")) left = clamp(start.x + dx, 0, right - 0.001);
            if (mode.includes("e")) right = clamp(start.x + start.w + dx, left + 0.001, 1);
            if (mode.includes("n")) top = clamp(start.y + dy, 0, bottom - 0.001);
            if (mode.includes("s")) bottom = clamp(start.y + start.h + dy, top + 0.001, 1);
            Object.assign(active, { x: left, y: top, w: right - left, h: bottom - top });
        }
        this.paint();
    }

    pointerUp(event) {
        if (!this.drag) return;
        const region = this.active();
        if (this.drag.mode === "draw" && (region.w < 0.003 || region.h < 0.003)) {
            this.regions = this.regions.filter((r) => r.id !== region.id);
            this.selected = null;
        }
        this.drag = null;
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.changed(); this.notifyGraph();
    }

    cancelDrag() {
        if (!this.drag) return;
        this.regions = readRegions(this.drag.before);
        this.drag = null;
        if (!this.active()) this.selected = null;
        this.changed();
    }

    keydown(event) {
        if (event.target.closest("input, textarea, select, [contenteditable=true]")) return;
        const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
        if (key === "escape") { this.cancelDrag(); this.closeMenu(); this.select(null); return; }
        if (this.drag) return;
        if (key === "delete" || key === "backspace") { event.preventDefault(); this.remove(); }
        else if (modifier && key === "c" && this.active()) { event.preventDefault(); copiedRegion = plainRegion(this.active()); }
        else if (modifier && key === "v" && copiedRegion) { event.preventDefault(); this.pasteRegion(copiedRegion); }
        else if (modifier && key === "d" && this.active()) { event.preventDefault(); this.duplicate(); }
    }

    pasteRegion(source) {
        const region = plainRegion(source);
        region.id = uid();
        region.x = Math.min(1 - region.w, region.x + 0.025);
        region.y = Math.min(1 - region.h, region.y + 0.025);
        this.regions.unshift(region);
        this.selected = region.id;
        this.changed(); this.notifyGraph();
    }

    duplicate() { if (this.active()) this.pasteRegion(this.active()); }
    remove() {
        if (!this.active()) return;
        this.regions = this.regions.filter((region) => region.id !== this.selected);
        this.selected = null;
        this.changed(); this.notifyGraph();
    }

    reorder(from, to) {
        if (to < 0 || to >= this.regions.length || from === to) return;
        const [region] = this.regions.splice(from, 1);
        this.regions.splice(to, 0, region);
        this.changed(); this.notifyGraph();
    }

    moveLayer(delta) {
        const index = this.regions.findIndex((region) => region.id === this.selected);
        if (index >= 0) this.reorder(index, index + delta);
    }

    closeMenu() {
        this.menu?.remove(); this.menu = null;
        this.menuEvents?.abort();
    }

    contextMenu(event) {
        this.closeMenu();
        const menu = element("div", "ming-builder ming-menu");
        menu.setAttribute("role", "menu");
        this.listen(menu, "keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") this.closeMenu();
        });
        for (const [label, action] of [["Bring forward", () => this.moveLayer(-1)], ["Send backward", () => this.moveLayer(1)],
            ["Duplicate layer", () => this.duplicate()], ["Delete layer", () => this.remove()],
            ["Copy Ming JSON", () => this.copyJSON()], ["Import Ming JSON", () => this.jsonDialog()]]) {
            const button = this.button(label, () => { this.closeMenu(); return action(); });
            button.setAttribute("role", "menuitem"); menu.append(button);
        }
        document.body.append(menu);
        menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
        menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
        this.menu = menu;
        this.menuEvents = new AbortController();
        document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target)) this.closeMenu(); }, { capture: true, signal: this.menuEvents.signal });
    }

    async clear() {
        if (!this.regions.length && !this.loadError) return;
        const approved = await app.extensionManager.dialog.confirm({ title: "Clear Ming regions",
            message: this.loadError ? "Discard the invalid editor state and start again?" : `Remove all ${this.regions.length} regions?` });
        if (!approved) return;
        this.regions = []; this.selected = null; this.loadError = false;
        this.changed(); this.notifyGraph();
    }

    async copyJSON() {
        if (this.connected("import_json")) throw new Error("Disconnect import_json or import its value into the editor before copying JSON.");
        const result = await request("serialize", this.payload());
        try {
            await navigator.clipboard.writeText(result.prompt);
            this.message("Ming JSON copied." + (result.warnings.length ? ` ${result.warnings.join(" ")}` : ""), result.warnings.length ? "warning" : "info");
        } catch (error) {
            // Clipboard permission/HTTP failures remain usable with an ordinary text selection.
            this.jsonDialog(result.prompt, true);
            this.message(`Clipboard unavailable (${error.message}). Copy from the open JSON field.`, "warning");
        }
    }

    jsonDialog(initial = this.value("import_json") || "", readOnly = false) {
        this.dialog?.remove();
        const dialog = element("dialog", "ming-builder ming-json-dialog");
        const heading = element("h3", "", readOnly ? "Ming JSON" : "Import Ming JSON");
        const text = element("textarea");
        text.value = initial; text.readOnly = readOnly; text.spellcheck = false;
        text.setAttribute("aria-label", "Ming JSON");
        const help = element("p", "ming-help", readOnly ? "Select all and copy the complete prompt." : "Import replaces regions and canvas settings. The editor keeps the imported aspect ratio.");
        const error = element("p", "ming-dialog-error");
        error.setAttribute("role", "alert");
        const actions = element("div", "ming-dialog-actions");
        actions.append(this.button("Close", () => dialog.close()));
        if (!readOnly) {
            actions.append(this.button("Paste clipboard", async () => {
                try { text.value = await navigator.clipboard.readText(); }
                catch { error.textContent = "Clipboard access is unavailable. Paste into the field with Ctrl/Cmd+V."; text.focus(); }
            }));
            actions.append(this.button("Import into editor", async () => {
                try {
                    if (this.connected("import_json")) throw new Error("Disconnect import_json before editing its imported value.");
                    const result = await request("import", { prompt: text.value, width: Number(this.value("width")), height: Number(this.value("height")) });
                    this.applyImport(result);
                    field(this.node, "import_json").value = "";
                    this.changed(); this.notifyGraph();
                    dialog.close();
                } catch (failure) { error.textContent = failure.message; }
            }));
            actions.append(this.button("Use as execution input", () => {
                if (this.connected("import_json")) { error.textContent = "import_json is connected."; return; }
                this.setSetting("import_json", text.value); this.notifyGraph(); dialog.close();
            }, "Keep this JSON in the import_json input. It overrides the editor each time this node runs."));
        }
        dialog.append(heading, help, text, error, actions);
        this.listen(dialog, "keydown", (event) => event.stopPropagation());
        this.listen(dialog, "close", () => { dialog.remove(); if (this.dialog === dialog) this.dialog = null; });
        document.body.append(dialog);
        this.dialog = dialog; dialog.showModal(); text.focus();
        if (readOnly) text.select();
    }

    applyImport(result) {
        this.regions = Array.from(result.regions, plainRegion);
        this.selected = null; this.loadError = false;
        for (const name of ["width", "height", "image_style", "ambient_lighting"]) field(this.node, name).value = result[name];
        this.syncSettings();
    }

    executed(output) {
        const result = output?.ming?.[0];
        if (!result) return;
        if (this.queuedRevision !== undefined && this.revision !== this.queuedRevision) {
            this.message("Execution finished using earlier inputs. Your newer editor changes were kept.");
            return;
        }
        if (result.regions) this.applyImport(result);
        else for (const name of ["width", "height", "image_style", "ambient_lighting"]) field(this.node, name).value = result[name];
        for (const name of ["bg_brightness", "output_format"]) field(this.node, name).value = result[name];
        this.executedBackground = output.ming_background?.[0] || "";
        this.loadBackground(this.executedBackground);
        this.syncSettings(); this.persist(); this.renderLayers(); this.renderInspector();
        this.message(result.warnings.length ? result.warnings.join("\n") : "Ming prompt and layout preview ready.", result.warnings.length ? "warning" : "info");
    }

    refreshBackground() {
        const input = this.node.inputs?.find((input) => input.name === "image");
        if (input?.link == null) {
            this.executedBackground = "";
            if (this.backgroundSource) this.loadBackground("");
            return;
        }
        const link = this.node.graph?.links?.[input.link];
        const source = link && this.node.graph.getNodeById(link.origin_id);
        let url = "";
        if (source?.comfyClass === "LoadImage") {
            const name = field(source, "image")?.value;
            if (typeof name === "string" && name) {
                const annotated = /^(.*?)\s+\[(input|temp|output)\]$/.exec(name);
                const file = annotated ? annotated[1] : name;
                const slash = file.lastIndexOf("/");
                url = api.apiURL(`/view?${new URLSearchParams({ filename: file.slice(slash + 1),
                    subfolder: slash < 0 ? "" : file.slice(0, slash), type: annotated ? annotated[2] : "input" })}`);
            }
        }
        if (!url) url = source?.imgs?.[0]?.src || this.executedBackground;
        if (url !== this.backgroundSource) this.loadBackground(url);
    }

    loadBackground(source) {
        this.backgroundSource = source || "";
        this.background = null;
        if (!source) { this.paint(); return; }
        const image = new Image();
        image.onload = () => {
            if (this.backgroundSource !== source || this.destroyed) return;
            this.background = image; this.paint();
        };
        image.onerror = () => {
            if (this.backgroundSource === source && !this.destroyed) this.message("Background preview could not be loaded. Run the node to refresh it.", "warning");
        };
        image.src = source;
    }

    paint() {
        if (this.paintFrame || this.destroyed) return;
        this.paintFrame = requestAnimationFrame(() => { this.paintFrame = 0; this.draw(); });
    }

    draw() {
        const availableW = this.stage.clientWidth - 20, availableH = this.stage.clientHeight - 20;
        if (availableW < 1 || availableH < 1) return;
        const aspect = Number(this.value("width")) / Number(this.value("height")) || 1;
        let width = availableW, height = width / aspect;
        if (height > availableH) { height = availableH; width = height * aspect; }
        this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
        const graphScale = this.canvas.getBoundingClientRect().width / width || 1;
        const dpr = (window.devicePixelRatio || 1) * graphScale;
        const pixelW = Math.max(1, Math.round(width * dpr)), pixelH = Math.max(1, Math.round(height * dpr));
        if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) { this.canvas.width = pixelW; this.canvas.height = pixelH; }
        const ctx = this.canvas.getContext("2d");
        ctx.setTransform(pixelW / width, 0, 0, pixelH / height, 0, 0);
        ctx.fillStyle = "#141820"; ctx.fillRect(0, 0, width, height);
        if (this.background) {
            const scale = Math.min(width / this.background.width, height / this.background.height);
            const w = this.background.width * scale, h = this.background.height * scale;
            ctx.filter = `brightness(${Number(this.value("bg_brightness"))}%)`;
            ctx.drawImage(this.background, (width - w) / 2, (height - h) / 2, w, h);
            ctx.filter = "none";
        }
        if (!this.regions.length) {
            ctx.fillStyle = "#939EAF"; ctx.textAlign = "center"; ctx.font = "13px sans-serif";
            ctx.fillText("Draw a region", width / 2, height / 2);
        }
        // Painter's order is BACK -> FRONT, although the editor list is FRONT -> BACK.
        for (let i = this.regions.length - 1; i >= 0; i--) {
            const region = this.regions[i];
            const x = region.x * width, y = region.y * height, w = region.w * width, h = region.h * height;
            const color = validHex(region.colors[0] || "") ? region.colors[0] : "#8AB4F8";
            ctx.strokeStyle = color; ctx.lineWidth = 1.5;
            ctx.strokeRect(x, y, w, h);
            ctx.globalAlpha = 0.07; ctx.fillStyle = color; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1;
            const tag = `${String(this.regions.length - i).padStart(2, "0")} ${region.kind === "text" ? "TEXT" : "OBJ"}`;
            ctx.font = "10px sans-serif"; ctx.textAlign = "left";
            const tagW = ctx.measureText(tag).width + 10;
            const tagX = clamp(x, 0, Math.max(0, width - tagW));
            const tagY = clamp(y, 0, Math.max(0, height - 18));
            ctx.fillStyle = "#141820"; ctx.fillRect(tagX, tagY, tagW, 18);
            ctx.strokeStyle = color; ctx.strokeRect(tagX, tagY, tagW, 18);
            ctx.fillStyle = "#F4F7FC"; ctx.fillText(tag, tagX + 5, tagY + 12);
        }
        const selected = this.active();
        if (selected) {
            ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2;
            ctx.strokeRect(selected.x * width, selected.y * height, selected.w * width, selected.h * height);
            for (const [, x, y] of this.handles(selected)) {
                ctx.fillStyle = "#FFFFFF"; ctx.fillRect(x * width - 3, y * height - 3, 6, 6);
                ctx.strokeStyle = "#1E293B"; ctx.lineWidth = 1; ctx.strokeRect(x * width - 3, y * height - 3, 6, 6);
            }
        }
    }

    destroy() {
        this.destroyed = true;
        this.events.abort(); this.validationRequest?.abort();
        clearTimeout(this.validationTimer); cancelAnimationFrame(this.paintFrame);
        this.resizeObserver.disconnect(); this.closeMenu(); this.dialog?.remove();
        this.background = null; this.root.remove();
        EDITORS.delete(this.node);
    }
}

app.registerExtension({
    name: "MingImage.PromptBuilder",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;
        if (!document.querySelector("link[data-ming-builder]")) {
            const stylesheet = element("link");
            stylesheet.rel = "stylesheet";
            stylesheet.href = new URL("ming_prompt_builder.css", import.meta.url).href;
            stylesheet.dataset.mingBuilder = "true";
            document.head.append(stylesheet);
        }
        chain(nodeType.prototype, "onNodeCreated", function () {
            EDITORS.set(this, new MingEditor(this));
            this.resizable = true;
            this.size = [850, 840];
        });
    },
    loadedGraphNode(node) {
        if (node.comfyClass === NODE_TYPE) EDITORS.get(node)?.refreshBackground();
    },
});
