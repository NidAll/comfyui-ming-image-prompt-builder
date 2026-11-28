// SPDX-License-Identifier: GPL-3.0-only
// UX inspired by Kijai's Ideogram4PromptBuilderKJ (ComfyUI-KJNodes, GPL-3.0).
// Ming/MOSS state, DOM editor, and Python-backed import/export are implemented here independently.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EDITORS = new WeakMap();
const KIND_COLORS = { object: "#7DB4FF", character: "#F5B971", text: "#6EE7B7" };
const HISTORY_LIMIT = 50;

// One editor, two model-facing formats. Python owns each serializer; this only changes the fields shown.
export const FORMATS = {
    MingImagePromptBuilder: {
        route: "ming_prompt_builder", brand: ["MING", "Design · T2I"], json: "Ming JSON", ui: "ming", property: "ming_prompt_builder",
        kinds: [["object", "Object", "OBJ"], ["text", "Text", "TEXT"]], relation: true, tags: false, hexOnly: true,
        outputs: ["pretty", "compact"], caption: "Description", palette: "Colors",
        areas: [["image_style", "Image Style", "e.g. modern editorial poster"], ["ambient_lighting", "Ambient Lighting", "e.g. soft studio lighting"]],
        lines: [], selects: [],
        settings: ["width", "height", "image_style", "ambient_lighting", "bg_brightness", "output_format", "import_json"],
        canvas: ["width", "height", "image_style", "ambient_lighting"],
    },
    MossImagePromptBuilder: {
        route: "moss_prompt_builder", brand: ["MOSS", "Image · Layout"], json: "MOSS JSON", ui: "moss", property: "moss_prompt_builder",
        kinds: [["object", "Object", "OBJ"], ["character", "Character", "CHAR"], ["text", "Text", "TEXT"]], relation: false, tags: true, hexOnly: false,
        outputs: ["compact", "pretty"], caption: "Caption", palette: "Palette",
        areas: [["summary_caption", "Summary caption", "The whole image: subject, medium, style, lighting, mood…"]],
        lines: [["meta", "Meta", "poster, product campaign"], ["palette", "Palette", "#F4EBDD, deep teal"]],
        selects: [["canvas", "Canvas", ["single", "multi_panel", "collage"]]],
        settings: ["width", "height", "summary_caption", "meta", "canvas", "palette", "bg_brightness", "output_format", "import_json"],
        canvas: ["width", "height", "summary_caption", "meta", "canvas", "palette"],
    },
};
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

const ICONS = {
    eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.8"/></svg>',
    eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l12 12M6.4 6.5A2 2 0 0 0 9.5 9.6M4.4 4.5C2.7 5.6 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.3 0 2.5-.4 3.5-1M14.5 8s-1.2-2.2-3.2-3.4"/></svg>',
    lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
    unlock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.6-1.3"/></svg>',
};

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
    if (source.tags != null) {
        if (!Array.isArray(source.tags)) throw new Error("Region tags must be an array.");
        region.tags = Array.from(source.tags, (tag) => String(tag));
    }
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

async function request(route, operation, payload, signal) {
    const response = await api.fetchApi(`/${route}/${operation}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Ming editor request failed (${response.status}).`);
    return data;
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

class MingEditor {
    constructor(node, format) {
        this.node = node;
        this.fmt = format;
        this.regions = [];
        this.selected = null;
        this.hovered = null;
        this.drag = null;
        this.guides = { x: [], y: [] };
        this.tool = "select";
        this.gridMode = "off"; // "off" | "thirds" | "grid"
        this.snapEnabled = true;
        this.unit = "norm"; // "norm" | "px"
        this.activeTab = "scene"; // "scene" | "region"
        this.layersCollapsed = false;
        this.lockedIds = new Set();
        this.hiddenIds = new Set();
        this.history = [];
        this.historyIndex = -1;
        this.statusFullText = "";
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
            serialize: false, hideOnZoom: false, getMinHeight: () => 560,
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
        for (const name of this.fmt.settings) {
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
            if (node.size[0] < 580) node.size[0] = 580;
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

    button(label, action, title = label, className = "ming-button") {
        const button = element("button", className, label);
        button.type = "button";
        button.title = title;
        this.listen(button, "click", (event) => {
            event.stopPropagation();
            Promise.resolve().then(action).catch((error) => this.error(error));
        });
        return button;
    }

    inputArea(label, value, action, placeholder = "", extraClass = "") {
        const group = element("label", "ming-field");
        const heading = element("span", "ming-label", label);
        const input = element("textarea", extraClass);
        input.value = value;
        input.rows = 2;
        input.placeholder = placeholder;
        input.spellcheck = false;
        input.setAttribute("aria-label", label);
        this.listen(input, "input", () => action(input.value));
        this.listen(input, "change", () => { this.recordHistory(); this.notifyGraph(); });
        group.append(heading, input);
        return { group, input };
    }

    buildUI() {
        // 1. Top Toolbar
        const toolbar = element("div", "ming-toolbar");
        const identity = element("div", "ming-identity");
        this.layersToggleBtn = this.button("◧", () => this.toggleLayersPane(), "Toggle layers panel", "ming-icon-btn");
        this.layersToggleBtn.setAttribute("aria-label", "Toggle layers panel");
        this.layersToggleBtn.setAttribute("aria-pressed", "true");
        identity.append(this.layersToggleBtn, element("strong", "", this.fmt.brand[0]), element("span", "", this.fmt.brand[1]));

        const historyGroup = element("div", "ming-toolbar-group");
        this.undoBtn = this.button("↶", () => this.undo(), "Undo (Ctrl/Cmd+Z)", "ming-icon-btn");
        this.undoBtn.setAttribute("aria-label", "Undo");
        this.redoBtn = this.button("↷", () => this.redo(), "Redo (Ctrl/Cmd+Shift+Z)", "ming-icon-btn");
        this.redoBtn.setAttribute("aria-label", "Redo");
        historyGroup.append(this.undoBtn, this.redoBtn);

        const actionsGroup = element("div", "ming-toolbar-group");
        const importBtn = this.button("Import JSON", () => this.jsonDialog(), `Import ${this.fmt.json}`);
        const copyBtn = this.button("Copy JSON", () => this.copyJSON(), `Copy ${this.fmt.json}`, "ming-button ming-btn-primary");
        this.format = element("select", "ming-format-select");
        this.format.setAttribute("aria-label", "Output format");
        this.format.title = "JSON output format";
        for (const name of this.fmt.outputs) {
            const option = element("option", "", name);
            option.value = name;
            this.format.append(option);
        }
        this.listen(this.format, "change", () => this.setSetting("output_format", this.format.value));
        const clearBtn = this.button("Clear", () => this.clear(), "Clear all regions", "ming-button ming-btn-ghost ming-btn-danger");
        actionsGroup.append(importBtn, copyBtn, this.format, element("span", "ming-sep"), clearBtn);

        toolbar.append(identity, historyGroup, element("span", "ming-sep"), actionsGroup);

        // 2. Main 3-Pane Studio Content
        this.content = element("div", "ming-content");

        // 2a. Left Rail: Layers
        const layersPane = element("div", "ming-layers-pane");
        const layerHeader = element("div", "ming-pane-header");
        const titleWrap = element("span", "ming-pane-title");
        this.layerCount = element("span", "ming-count-pill", "0");
        titleWrap.append(element("span", "", "LAYERS"), this.layerCount);
        layerHeader.append(titleWrap, element("span", "ming-order-hint", "FRONT ↑"));
        this.layerList = element("div", "ming-layers");
        this.layerList.setAttribute("role", "listbox");
        this.layerList.setAttribute("aria-label", "Layers, front to back");
        layersPane.append(layerHeader, this.layerList);

        // 2b. Center Pane: Canvas Workspace
        const workspace = element("div", "ming-workspace");
        const canvasBar = element("div", "ming-canvas-bar");

        const toolControls = element("div", "ming-canvas-tools");
        const toolSwitch = element("div", "ming-segmented");
        toolSwitch.setAttribute("role", "group");
        toolSwitch.setAttribute("aria-label", "Canvas tool");
        this.selectToolBtn = this.button("Select", () => this.setTool("select"), "Select & move regions (V)");
        this.drawToolBtn = this.button("Draw", () => this.setTool("draw"), "Draw new regions over any layer (R)");
        toolSwitch.append(this.selectToolBtn, this.drawToolBtn);

        this.gridBtn = this.button("Grid", () => this.cycleGrid(), "Cycle layout guides: Off → Thirds → 4×4 Grid", "ming-icon-btn");
        this.gridBtn.setAttribute("aria-label", "Toggle layout grid");
        this.snapBtn = this.button("Snap", () => this.toggleSnap(), "Magnetic alignment snapping (hold Alt while dragging to bypass)", "ming-icon-btn");
        this.snapBtn.setAttribute("aria-label", "Toggle snapping");
        toolControls.append(toolSwitch, this.gridBtn, this.snapBtn);

        const canvasMeta = element("div", "ming-canvas-meta");
        this.dimensions = element("span", "ming-dim-pill");
        this.brightness = element("input");
        this.brightness.type = "range";
        this.brightness.min = "0";
        this.brightness.max = "100";
        this.brightness.setAttribute("aria-label", "Background brightness");
        this.brightnessLabel = element("label", "ming-brightness inactive", "BG");
        this.brightnessLabel.title = "Background reference image brightness";
        this.brightnessValue = element("span");
        this.brightnessLabel.append(this.brightness, this.brightnessValue);
        this.listen(this.brightness, "input", () => this.setSetting("bg_brightness", Number(this.brightness.value)));
        this.listen(this.brightness, "change", () => this.notifyGraph());

        this.helpBtn = this.button("?", () => this.toggleShortcuts(), "Keyboard & canvas shortcuts", "ming-icon-btn");
        this.helpBtn.setAttribute("aria-label", "Keyboard shortcuts");
        canvasMeta.append(this.dimensions, this.brightnessLabel, this.helpBtn);

        canvasBar.append(toolControls, canvasMeta);

        this.stage = element("div", "ming-stage");
        this.canvas = element("canvas", "ming-canvas");
        this.canvas.tabIndex = 0;
        this.canvas.setAttribute("aria-label", `${this.fmt.brand[0]} region canvas`);
        this.canvas.title = "Drag to draw · Ctrl/Cmd-drag over existing regions · Alt-click cycles overlaps";
        // Hidden readonly input holds keyboard focus for canvas shortcuts so ComfyUI's
        // global ChangeTracker (window capture Ctrl+Z/Y) treats the editor as an active input.
        this.focusSink = element("input", "ming-canvas-focus");
        this.focusSink.type = "text";
        this.focusSink.readOnly = true;
        this.focusSink.tabIndex = -1;
        this.focusSink.setAttribute("aria-label", `${this.fmt.brand[0]} canvas keyboard focus`);
        this.stage.append(this.canvas, this.focusSink);
        workspace.append(canvasBar, this.stage);

        // 2c. Right Pane: Tabbed Inspector (Scene / Region)
        const inspectorPane = element("div", "ming-inspector-pane");
        const tabs = element("div", "ming-tabs");
        tabs.setAttribute("role", "tablist");
        this.sceneTabBtn = this.button("Scene", () => this.setTab("scene"), "Global prompt & canvas settings", "ming-tab");
        this.sceneTabBtn.setAttribute("role", "tab");
        this.regionTabBtn = this.button("Region", () => this.setTab("region"), "Selected region properties", "ming-tab");
        this.regionTabBtn.setAttribute("role", "tab");
        tabs.append(this.sceneTabBtn, this.regionTabBtn);

        this.inspectorScroll = element("div", "ming-inspector-scroll");

        // Scene Panel (persistent inputs so syncSettings stays live)
        this.scenePanel = element("div", "ming-panel ming-scene-panel");
        this.scenePanel.setAttribute("role", "tabpanel");
        this.sceneMeta = element("div", "ming-scene-meta-card");
        this.scenePanel.append(this.sceneMeta);
        this.settingInputs = [];
        for (const [name, label, placeholder] of this.fmt.areas) {
            const area = this.inputArea(label, "", (value) => this.setSetting(name, value), placeholder);
            area.input.rows = 3;
            this.settingInputs.push([name, area.input]);
            this.scenePanel.append(area.group);
        }
        if (this.fmt.ui === "moss") {
            const pairRow = element("div", "ming-settings-moss-row");
            for (const [name, label, placeholder] of this.fmt.lines.slice(0, 1)) {
                const group = element("label", "ming-field"), input = element("input");
                input.type = "text"; input.placeholder = placeholder; input.spellcheck = false;
                input.setAttribute("aria-label", label);
                this.listen(input, "input", () => this.setSetting(name, input.value));
                this.listen(input, "change", () => this.notifyGraph());
                group.append(element("span", "ming-label", label), input);
                this.settingInputs.push([name, input]); pairRow.append(group);
            }
            for (const [name, label, values] of this.fmt.selects) {
                const group = element("label", "ming-field"), select = element("select");
                select.setAttribute("aria-label", label);
                for (const value of values) { const option = element("option", "", value); option.value = value; select.append(option); }
                this.listen(select, "change", () => { this.setSetting(name, select.value); this.notifyGraph(); });
                group.append(element("span", "ming-label", label), select);
                this.settingInputs.push([name, select]); pairRow.append(group);
            }
            this.scenePanel.append(pairRow);
            for (const [name, label, placeholder] of this.fmt.lines.slice(1)) {
                const group = element("label", "ming-field"), input = element("input");
                input.type = "text"; input.placeholder = placeholder; input.spellcheck = false;
                input.setAttribute("aria-label", label);
                this.listen(input, "input", () => this.setSetting(name, input.value));
                this.listen(input, "change", () => this.notifyGraph());
                group.append(element("span", "ming-label", label), input);
                this.settingInputs.push([name, input]); this.scenePanel.append(group);
            }
        } else {
            for (const [name, label, placeholder] of this.fmt.lines) {
                const group = element("label", "ming-field"), input = element("input");
                input.type = "text"; input.placeholder = placeholder; input.spellcheck = false;
                input.setAttribute("aria-label", label);
                this.listen(input, "input", () => this.setSetting(name, input.value));
                this.listen(input, "change", () => this.notifyGraph());
                group.append(element("span", "ming-label", label), input);
                this.settingInputs.push([name, input]); this.scenePanel.append(group);
            }
            for (const [name, label, values] of this.fmt.selects) {
                const group = element("label", "ming-field"), select = element("select");
                select.setAttribute("aria-label", label);
                for (const value of values) { const option = element("option", "", value); option.value = value; select.append(option); }
                this.listen(select, "change", () => { this.setSetting(name, select.value); this.notifyGraph(); });
                group.append(element("span", "ming-label", label), select);
                this.settingInputs.push([name, select]); this.scenePanel.append(group);
            }
        }

        // Region Panel (dynamic per active region)
        this.inspector = element("div", "ming-panel ming-region-panel");
        this.inspector.setAttribute("role", "tabpanel");
        this.inspectorScroll.append(this.scenePanel, this.inspector);
        inspectorPane.append(tabs, this.inspectorScroll);

        this.content.append(layersPane, workspace, inspectorPane);

        // 3. Slim Status Footer
        this.statusBar = element("div", "ming-status-bar");
        this.statusBar.dataset.kind = "info";
        const dot = element("span", "ming-status-dot");
        this.status = element("div", "ming-status");
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        this.statusMoreBtn = this.button("Details", () => this.toggleStatusPopover(), "Show full validation details", "ming-status-more");
        this.statusBar.append(dot, this.status, this.statusMoreBtn);

        this.root.append(toolbar, this.content, this.statusBar);
        this.updateToolUI();
        this.updateTabs();
        this.updateUndoButtons();
    }

    toggleLayersPane() {
        this.layersCollapsed = !this.layersCollapsed;
        this.content.classList.toggle("layers-collapsed", this.layersCollapsed);
        this.layersToggleBtn.setAttribute("aria-pressed", String(!this.layersCollapsed));
        this.paint();
    }

    setTool(tool) {
        this.tool = tool;
        this.updateToolUI();
        this.paint();
    }

    cycleGrid() {
        const order = ["off", "thirds", "grid"];
        this.gridMode = order[(order.indexOf(this.gridMode) + 1) % order.length];
        this.updateToolUI();
        this.paint();
    }

    toggleSnap() {
        this.snapEnabled = !this.snapEnabled;
        this.updateToolUI();
    }

    updateToolUI() {
        this.selectToolBtn.setAttribute("aria-pressed", String(this.tool === "select"));
        this.drawToolBtn.setAttribute("aria-pressed", String(this.tool === "draw"));
        this.gridBtn.setAttribute("aria-pressed", String(this.gridMode !== "off"));
        this.gridBtn.textContent = this.gridMode === "thirds" ? "3×3" : this.gridMode === "grid" ? "4×4" : "Grid";
        this.snapBtn.setAttribute("aria-pressed", String(this.snapEnabled));
        if (!this.drag) this.canvas.style.cursor = this.tool === "draw" ? "crosshair" : "default";
    }

    setTab(tab) {
        this.activeTab = tab;
        this.updateTabs();
    }

    updateTabs() {
        const region = this.active();
        const regionNum = region ? String(this.regions.length - this.regions.indexOf(region)).padStart(2, "0") : "";
        this.regionTabBtn.textContent = region ? `Region ${regionNum}` : "Region";
        this.sceneTabBtn.setAttribute("aria-selected", String(this.activeTab === "scene"));
        this.regionTabBtn.setAttribute("aria-selected", String(this.activeTab === "region"));
        this.scenePanel.classList.toggle("is-hidden-panel", this.activeTab !== "scene");
        this.inspector.classList.toggle("is-hidden-panel", this.activeTab !== "region");
    }

    closePopovers() {
        this.popover?.remove();
        this.popover = null;
        this.popoverEvents?.abort();
        this.helpBtn?.setAttribute("aria-pressed", "false");
    }

    openPopover(el, anchorBtn = null) {
        this.closePopovers();
        this.root.append(el);
        this.popover = el;
        if (anchorBtn) anchorBtn.setAttribute("aria-pressed", "true");
        this.popoverEvents = new AbortController();
        document.addEventListener("pointerdown", (e) => {
            if (!el.contains(e.target) && (!anchorBtn || !anchorBtn.contains(e.target))) this.closePopovers();
        }, { capture: true, signal: this.popoverEvents.signal });
    }

    toggleShortcuts() {
        if (this.popover?.classList.contains("ming-shortcuts-popover")) { this.closePopovers(); return; }
        const pop = element("div", "ming-popover ming-shortcuts-popover");
        pop.append(element("h4", "", "Canvas Shortcuts"));
        const list = element("div", "ming-shortcut-list");
        const items = [
            ["V / R", "Select / Draw tool"],
            ["Drag", "Move or draw region"],
            ["Ctrl/Cmd + Drag", "Force-draw over layers"],
            ["Shift + Drag", "Lock square / aspect ratio"],
            ["Alt + Drag", "Bypass magnetic snap"],
            ["Alt + Click", "Cycle overlapping layers"],
            ["Arrows / Shift", "Nudge region (0.5% / 2.5%)"],
            ["Ctrl/Cmd + Z", "Undo (Shift+Z Redo)"],
            ["Ctrl/Cmd + C/V/D", "Copy / Paste / Duplicate"],
            ["Del / Esc", "Delete / Deselect"],
        ];
        for (const [key, desc] of items) {
            list.append(element("kbd", "", key), element("span", "", desc));
        }
        pop.append(list);
        this.openPopover(pop, this.helpBtn);
    }

    toggleStatusPopover() {
        if (this.popover?.classList.contains("ming-status-popover")) { this.closePopovers(); return; }
        const pop = element("div", "ming-popover ming-status-popover", this.statusFullText);
        this.openPopover(pop, this.statusMoreBtn);
    }

    hideWidgets() {
        for (const name of [...this.fmt.settings.filter((name) => !["width", "height"].includes(name)), "layers_data"]) {
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
        for (const [name, input] of [...this.settingInputs, ["output_format", this.format], ["bg_brightness", this.brightness]]) {
            if (input !== document.activeElement) input.value = this.value(name);
            input.disabled = this.connected(name);
            input.title = input.disabled ? "Controlled by a connected input; updates after execution." : "";
        }
        const w = Number(this.value("width")) || 1024, h = Number(this.value("height")) || 1024;
        const gcd = (a, b) => b ? gcd(b, a % b) : a;
        const divisor = gcd(w, h) || 1;
        const ratio = `${w / divisor}:${h / divisor}`;
        const mp = ((w * h) / 1e6).toFixed(2);
        this.dimensions.textContent = `${w}×${h} · ${ratio}`;
        this.brightnessValue.textContent = `${this.value("bg_brightness")}%`;
        this.brightnessLabel.classList.toggle("inactive", !this.connected("image") && !this.background);
        this.sceneMeta.replaceChildren(
            element("strong", "", `${w} × ${h} px (${ratio} · ${mp} MP)`),
            element("span", "", this.fmt.ui === "moss"
                ? (w % 16 === 0 && h % 16 === 0 ? "MOSS grid ready (multiples of 16)" : "MOSS requires width & height to be multiples of 16")
                : "Export order: back → front · Normalized cx/cy/w/h"),
        );
        this.paint();
    }

    snapshot() {
        const snapshot = plainState(this.durableRegions());
        snapshot.settings = {};
        for (const name of this.fmt.settings) {
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

    pruneEphemeralSets() {
        const ids = new Set(this.regions.map((r) => r.id));
        for (const id of this.lockedIds) if (!ids.has(id)) this.lockedIds.delete(id);
        for (const id of this.hiddenIds) if (!ids.has(id)) this.hiddenIds.delete(id);
        if (this.hovered && !ids.has(this.hovered)) this.hovered = null;
    }

    resetHistory() {
        this.history = [JSON.stringify(plainState(this.regions))];
        this.historyIndex = 0;
        this.updateUndoButtons();
    }

    recordHistory() {
        if (this.loadError || this.drag) return;
        const snap = JSON.stringify(plainState(this.regions));
        if (this.history[this.historyIndex] === snap) return;
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(snap);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.historyIndex = this.history.length - 1;
        this.updateUndoButtons();
    }

    updateUndoButtons() {
        if (!this.undoBtn) return;
        this.undoBtn.disabled = this.historyIndex <= 0;
        this.redoBtn.disabled = this.historyIndex < 0 || this.historyIndex >= this.history.length - 1;
    }

    applyHistory(index) {
        if (index < 0 || index >= this.history.length) return;
        this.historyIndex = index;
        this.regions = readRegions(this.history[index]);
        this.pruneEphemeralSets();
        if (this.selected && !this.active()) {
            this.selected = null;
            this.activeTab = "scene";
        }
        this.updateTabs();
        this.updateUndoButtons();
        this.changed(true);
        this.notifyGraph();
    }

    undo() { this.applyHistory(this.historyIndex - 1); }
    redo() { this.applyHistory(this.historyIndex + 1); }

    save(serialized) {
        if (this.loadError) return;
        this.persist();
        serialized.properties ??= {};
        serialized.properties[this.fmt.property] = this.snapshot();
        // LiteGraph and Vue versions differ in when serializeValue is called.
        // Force the saved widget string to exclude the execution-only selection.
        const index = this.node.widgets.indexOf(field(this.node, "layers_data"));
        if (Array.isArray(serialized.widgets_values)) serialized.widgets_values[index] = field(this.node, "layers_data").value;
    }

    restore(serialized) {
        try {
            const snapshot = serialized?.properties?.[this.fmt.property];
            this.regions = readRegions(snapshot ? JSON.stringify(snapshot) : this.value("layers_data"));
            if (snapshot?.settings) {
                for (const name of this.fmt.settings) {
                    if (Object.hasOwn(snapshot.settings, name)) field(this.node, name).value = snapshot.settings[name];
                }
            }
            this.selected = null;
            this.hovered = null;
            this.drag = null;
            this.guides = { x: [], y: [] };
            this.lockedIds.clear();
            this.hiddenIds.clear();
            this.activeTab = "scene";
            this.loadError = false;
            this.hideWidgets();
            this.persist();
            this.resetHistory();
            this.syncSettings();
            this.updateTabs();
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
        this.pruneEphemeralSets();
        this.persist();
        if (rebuild) { this.updateTabs(); this.renderLayers(); this.renderInspector(); }
        this.paint();
        this.scheduleValidation();
    }

    message(text, kind = "info") {
        this.statusFullText = text || "";
        const lines = this.statusFullText.split("\n").filter(Boolean);
        this.status.textContent = lines.length > 1 ? lines.join(" · ") : this.statusFullText;
        this.status.title = this.statusFullText;
        this.status.dataset.kind = kind;
        this.statusBar.dataset.kind = kind;
        const hasMore = lines.length > 1;
        this.statusMoreBtn.classList.toggle("visible", hasMore);
        if (hasMore) this.statusMoreBtn.textContent = `${lines.length} ${kind === "error" ? "errors" : "notices"}`;
        else if (this.popover?.classList.contains("ming-status-popover")) this.closePopovers();
    }

    error(error) {
        console.error(`[${this.node.comfyClass}]`, error);
        this.message(error.message || String(error), "error");
    }

    payload() {
        const payload = { layers_data: JSON.stringify(plainState(this.durableRegions())), import_json: this.value("import_json") || "",
            output_format: this.value("output_format") };
        for (const name of this.fmt.canvas) payload[name] = ["width", "height"].includes(name) ? Number(this.value(name)) : this.value(name);
        return payload;
    }

    kindTag(kind) { return (this.fmt.kinds.find(([name]) => name === kind) || this.fmt.kinds[0])[2]; }
    regionColor(region) { return region.colors.find(validHex) || KIND_COLORS[region.kind] || "#7DB4FF"; }

    scheduleValidation() {
        clearTimeout(this.validationTimer);
        this.validationTimer = setTimeout(() => this.validate(), 400);
    }

    async validate() {
        this.validationRequest?.abort();
        this.validationRequest = new AbortController();
        const revision = this.revision;
        try {
            const result = await request(this.fmt.route, "serialize", this.payload(), this.validationRequest.signal);
            if (revision !== this.revision || this.destroyed) return;
            const warnings = [...result.warnings];
            if (this.value("import_json")?.trim() || this.connected("import_json")) {
                warnings.unshift("import_json overrides the editor on execution. Import into editor to edit locally.");
            }
            const valid = result.mode === "caption" ? "Caption prompt (draw regions for a Layout)" : `Valid ${this.fmt.json}`;
            this.message(warnings.length ? warnings.join("\n") : `${this.regions.length} regions · ${valid} · Export order: back → front`, warnings.length ? "warning" : "info");
        } catch (error) {
            if (error.name !== "AbortError" && revision === this.revision && !this.destroyed) this.message(error.message, "error");
        }
    }

    select(id) {
        this.selected = id;
        this.activeTab = id ? "region" : "scene";
        this.updateTabs();
        this.renderLayers();
        this.renderInspector();
        this.paint();
    }

    setHover(id) {
        if (this.hovered === id) return;
        this.hovered = id;
        for (const row of this.layerList.children) {
            row.classList.toggle("hovered", Boolean(id) && row.dataset.regionId === id);
        }
        this.paint();
    }

    active() { return this.regions.find((region) => region.id === this.selected); }

    toggleHidden(id) {
        if (this.hiddenIds.has(id)) this.hiddenIds.delete(id);
        else this.hiddenIds.add(id);
        this.renderLayers();
        this.paint();
    }

    toggleLocked(id) {
        if (this.lockedIds.has(id)) this.lockedIds.delete(id);
        else this.lockedIds.add(id);
        this.renderLayers();
        if (this.selected === id) this.renderInspector();
        this.paint();
    }

    renderLayers() {
        this.layerCount.textContent = String(this.regions.length);
        this.layerList.replaceChildren();
        if (!this.regions.length) {
            this.layerList.append(element("p", "ming-empty", "Draw on the canvas to add your first region."));
            return;
        }
        this.regions.forEach((region, index) => {
            const isHidden = this.hiddenIds.has(region.id);
            const isLocked = this.lockedIds.has(region.id);
            const row = element("div", `ming-layer${region.id === this.selected ? " selected" : ""}${region.id === this.hovered ? " hovered" : ""}${isHidden ? " is-hidden" : ""}`);
            row.dataset.regionId = region.id;
            row.tabIndex = 0;
            row.draggable = true;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(region.id === this.selected));
            row.setAttribute("aria-label", `Layer ${this.regions.length - index}, ${region.kind}`);

            const swatch = element("span", "ming-layer-swatch");
            swatch.style.background = this.regionColor(region);
            const typeBadge = element("span", "ming-type", this.kindTag(region.kind));
            typeBadge.dataset.kind = region.kind;
            const labelText = region.kind === "text" ? region.text || "Untitled text" : region.description || `Untitled ${region.kind}`;
            const label = element("span", "ming-layer-label", labelText);
            label.title = labelText;

            const controls = element("span", "ming-layer-controls");
            const hideBtn = this.button("", () => this.toggleHidden(region.id), isHidden ? "Show on canvas" : "Hide on canvas", "ming-layer-mini");
            hideBtn.innerHTML = isHidden ? ICONS.eyeOff : ICONS.eye;
            hideBtn.setAttribute("aria-label", isHidden ? "Show layer" : "Hide layer");
            hideBtn.setAttribute("aria-pressed", String(isHidden));
            const lockBtn = this.button("", () => this.toggleLocked(region.id), isLocked ? "Unlock region" : "Lock region (click-through)", "ming-layer-mini");
            lockBtn.innerHTML = isLocked ? ICONS.lock : ICONS.unlock;
            lockBtn.setAttribute("aria-label", isLocked ? "Unlock layer" : "Lock layer");
            lockBtn.setAttribute("aria-pressed", String(isLocked));
            controls.append(hideBtn, lockBtn);

            row.append(element("span", "ming-drag-grip", "⠿"), swatch,
                element("span", "ming-layer-number", String(this.regions.length - index).padStart(2, "0")),
                typeBadge, label, controls);

            this.listen(row, "click", () => this.select(region.id));
            this.listen(row, "dblclick", () => {
                this.select(region.id);
                this.inspector.querySelector("textarea")?.focus();
            });
            this.listen(row, "pointerenter", () => this.setHover(region.id));
            this.listen(row, "pointerleave", () => { if (this.hovered === region.id) this.setHover(null); });
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
            this.listen(row, "dragover", (event) => {
                event.preventDefault();
                const from = this.regions.findIndex((r) => r.id === this.reorderId);
                row.classList.toggle("drop-before", from > index);
                row.classList.toggle("drop-after", from >= 0 && from < index);
            });
            this.listen(row, "dragleave", () => { row.classList.remove("drop-before", "drop-after"); });
            this.listen(row, "drop", (event) => {
                event.preventDefault();
                row.classList.remove("drop-before", "drop-after");
                const from = this.regions.findIndex((r) => r.id === this.reorderId);
                if (from >= 0) this.reorder(from, index);
                this.reorderId = null;
            });
            this.listen(row, "dragend", () => { this.reorderId = null; this.renderLayers(); });
            this.layerList.append(row);
        });
    }

    renderInspector() {
        const scroll = this.inspector.dataset.regionId === this.selected ? this.inspectorScroll.scrollTop : 0;
        this.inspector.dataset.regionId = this.selected || "";
        this.inspector.replaceChildren();
        const region = this.active();
        if (!region) {
            this.inspector.append(
                element("p", "ming-empty", `Select or draw a region to edit ${this.fmt.kinds.length > 2 ? "an object, a character" : "an object"} or exact text.`),
                element("p", "ming-help", "Tip: Use the Scene tab for global prompt settings, or press R to draw over background layers."),
            );
            return;
        }
        const isLocked = this.lockedIds.has(region.id);
        const layerNum = String(this.regions.length - this.regions.indexOf(region)).padStart(2, "0");

        // Hoisted header with quick actions always visible above the fold
        const headerRow = element("div", "ming-region-header");
        const title = element("div", "ming-inspector-title");
        const kindPill = element("span", "ming-type", this.kindTag(region.kind));
        kindPill.dataset.kind = region.kind;
        title.append(element("span", "", `REGION ${layerNum}`), kindPill);

        const headerActions = element("div", "ming-region-header-actions");
        const frontBtn = this.button("↑", () => this.moveLayer(-1), "Bring forward", "ming-icon-btn");
        frontBtn.setAttribute("aria-label", "↑ Front");
        const backBtn = this.button("↓", () => this.moveLayer(1), "Send backward", "ming-icon-btn");
        backBtn.setAttribute("aria-label", "↓ Back");
        const dupBtn = this.button("⧉", () => this.duplicate(), "Duplicate (Ctrl/Cmd+D)", "ming-icon-btn");
        dupBtn.setAttribute("aria-label", "Duplicate");
        const delBtn = this.button("✕", () => this.remove(), "Delete (Del)", "ming-icon-btn ming-btn-danger");
        delBtn.setAttribute("aria-label", "Delete");
        headerActions.append(frontBtn, backBtn, dupBtn, delBtn);
        headerRow.append(title, headerActions);

        const type = element("div", "ming-type-switch");
        type.setAttribute("aria-label", "Region type");
        for (const [name, label] of this.fmt.kinds) {
            const button = this.button(label, () => {
                if (region.kind === name) return;
                // Switching imported text to Object preserves the full source description.
                if (name === "object" && region.raw_description) region.description = region.raw_description;
                delete region.raw_description;
                region.kind = name;
                this.recordHistory();
                this.changed(); this.notifyGraph();
            });
            button.setAttribute("aria-pressed", String(region.kind === name));
            type.append(button);
        }
        this.inspector.append(headerRow, type);

        const updateText = (key, value) => {
            region[key] = value;
            delete region.raw_description;
            this.changed(false); this.renderLayers();
        };
        // Text-first priority when editing a Text region
        if (region.kind === "text") {
            const exact = this.inputArea("Exact Text", region.text, (value) => updateText("text", value),
                "Preserved exactly, including spacing and line breaks", "ming-exact-text");
            this.inspector.append(exact.group);
        }
        const description = this.inputArea(this.fmt.caption, region.description, (value) => updateText("description", value),
            region.kind === "text" ? "Visual appearance, typography, material…" : "Describe this visible object or group…");
        this.inspector.append(description.group);

        if (this.fmt.relation) {
            const relation = this.inputArea("Hierarchy / Relation", region.relation, (value) => {
                region.relation = value; this.changed(false);
            }, "e.g. primary title above the central subject");
            this.inspector.append(relation.group);
        }
        if (this.fmt.tags) {
            const tags = this.inputArea("Tags", (region.tags || []).join(", "), (value) => {
                region.tags = value.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean); this.changed(false);
            }, "Optional, comma separated: full body, three-quarter view");
            tags.input.rows = 1;
            this.inspector.append(tags.group);
        }
        if (region.raw_description) {
            const note = element("details", "ming-source");
            note.append(element("summary", "", "Imported description preserved"), element("p", "", region.raw_description));
            this.inspector.append(note);
        }

        // Compact Color Chips
        const colorWrap = element("div", "ming-colors-wrap");
        const colorHead = element("div", "ming-section-head");
        const addColorBtn = this.button("+ Color", () => {
            region.colors.push("#FFFFFF");
            this.recordHistory();
            this.changed(); this.notifyGraph();
        }, "Add color swatch", "ming-add-color-btn");
        colorHead.append(element("span", "ming-label", this.fmt.palette), addColorBtn);
        this.colorEditor = element("div", "ming-colors");
        colorWrap.append(colorHead, this.colorEditor);
        this.inspector.append(colorWrap);
        this.renderColors(region);

        // Layout Alignment & Geometry (norm / px toggle)
        const layoutBox = element("div", "ming-layout-box");
        const layoutHead = element("div", "ming-section-head");
        const unitToggle = element("div", "ming-unit-toggle");
        unitToggle.setAttribute("role", "group");
        unitToggle.setAttribute("aria-label", "Coordinate units");
        for (const [mode, label] of [["norm", "norm"], ["px", "px"]]) {
            const btn = this.button(label, () => {
                if (this.unit === mode) return;
                this.unit = mode;
                this.renderInspector();
            }, `Display coordinates in ${mode === "px" ? "pixels" : "normalized 0–1"}`);
            btn.setAttribute("aria-pressed", String(this.unit === mode));
            unitToggle.append(btn);
        }
        layoutHead.append(element("span", "ming-label", isLocked ? "Layout (locked)" : "Layout"), unitToggle);

        const alignBar = element("div", "ming-align-bar");
        const aligns = [
            ["⇤", "left", "Align left edge"],
            ["↔", "center-x", "Center horizontally"],
            ["⇥", "right", "Align right edge"],
            ["⤒", "top", "Align top edge"],
            ["↕", "center-y", "Center vertically"],
            ["⤓", "bottom", "Align bottom edge"],
            ["⤢", "fill", "Fit full canvas"],
        ];
        for (const [icon, mode, tip] of aligns) {
            const btn = this.button(icon, () => this.alignSelected(mode), tip);
            btn.setAttribute("aria-label", tip);
            btn.disabled = isLocked;
            alignBar.append(btn);
        }

        const cw = Number(this.value("width")) || 1024;
        const ch = Number(this.value("height")) || 1024;
        const geometry = element("div", "ming-geometry");
        for (const key of ["x", "y", "w", "h"]) {
            const isX = key === "x" || key === "w";
            const axisSize = isX ? cw : ch;
            const isSize = key === "w" || key === "h";
            const label = element("label", "", key.toUpperCase());
            const input = element("input");
            input.type = "number";
            input.disabled = isLocked;
            if (this.unit === "px") {
                input.min = isSize ? "1" : "0";
                input.max = String(axisSize);
                input.step = "1";
                input.value = String(Math.round(region[key] * axisSize));
                input.setAttribute("aria-label", `Pixel ${key}`);
            } else {
                input.min = isSize ? "0.001" : "0";
                input.max = "1";
                input.step = "0.001";
                input.value = region[key].toFixed(3);
                input.setAttribute("aria-label", `Normalized ${key}`);
            }
            this.listen(input, "change", () => {
                const raw = Number(input.value);
                if (!input.value || !Number.isFinite(raw)) {
                    input.value = this.unit === "px" ? String(Math.round(region[key] * axisSize)) : region[key].toFixed(3);
                    return;
                }
                const value = this.unit === "px" ? raw / axisSize : raw;
                if (key === "x" || key === "y") region[key] = clamp(value, 0, 1 - region[key === "x" ? "w" : "h"]);
                else region[key] = clamp(value, 0.001, 1 - region[key === "w" ? "x" : "y"]);
                this.recordHistory();
                this.changed(); this.notifyGraph();
            });
            label.append(input);
            geometry.append(label);
        }
        layoutBox.append(layoutHead, alignBar, geometry);
        this.inspector.append(layoutBox);
        if (this.activeTab === "region") this.inspectorScroll.scrollTop = scroll;
    }

    renderColors(region) {
        this.colorEditor.replaceChildren();
        if (!region.colors.length) {
            this.colorEditor.append(element("span", "ming-help", "No explicit palette colors"));
            return;
        }
        region.colors.forEach((color, index) => {
            const row = element("div", `ming-color-row${this.fmt.hexOnly ? "" : " is-freeform"}`);
            const picker = element("input");
            picker.type = "color"; picker.value = validHex(color) ? color : "#FFFFFF";
            picker.setAttribute("aria-label", `Color swatch ${index + 1}`);
            const hex = element("input");
            hex.type = "text"; hex.value = color;
            hex.setAttribute("aria-label", `Color hex ${index + 1}`);
            if (this.fmt.hexOnly) { hex.maxLength = 7; hex.pattern = "#[0-9A-Fa-f]{6}"; }
            const setColor = (value) => {
                // MOSS palettes may also name colors ("deep teal"); Ming accepts #RRGGBB only.
                region.colors[index] = this.fmt.hexOnly || validHex(value) ? value.toUpperCase() : value;
                if (hex.value !== region.colors[index] && (this.fmt.hexOnly || validHex(value))) hex.value = region.colors[index];
                hex.setCustomValidity(!this.fmt.hexOnly || validHex(value) ? "" : "Use #RRGGBB.");
                if (validHex(value)) picker.value = value;
                this.changed(false); this.renderLayers();
            };
            this.listen(picker, "input", () => setColor(picker.value));
            this.listen(picker, "change", () => { this.recordHistory(); this.notifyGraph(); });
            this.listen(hex, "input", () => setColor(hex.value));
            this.listen(hex, "change", () => { this.recordHistory(); this.notifyGraph(); });
            const remove = this.button("×", () => {
                region.colors.splice(index, 1);
                this.recordHistory();
                this.changed(); this.notifyGraph();
            }, `Remove color ${index + 1}`, "ming-color-remove");
            remove.setAttribute("aria-label", `Remove color ${index + 1}`);
            row.append(picker, hex, remove);
            this.colorEditor.append(row);
        });
    }

    alignSelected(mode) {
        const region = this.active();
        if (!region || this.lockedIds.has(region.id)) return;
        if (mode === "left") region.x = 0;
        else if (mode === "center-x") region.x = (1 - region.w) / 2;
        else if (mode === "right") region.x = 1 - region.w;
        else if (mode === "top") region.y = 0;
        else if (mode === "center-y") region.y = (1 - region.h) / 2;
        else if (mode === "bottom") region.y = 1 - region.h;
        else if (mode === "fill") Object.assign(region, { x: 0, y: 0, w: 1, h: 1 });
        this.recordHistory();
        this.changed(); this.notifyGraph();
    }

    focusCanvas() {
        this.focusSink.focus({ preventScroll: true });
    }

    installEvents() {
        for (const type of ["pointerdown", "mousedown", "dblclick", "wheel", "keydown", "keyup"]) {
            this.listen(this.root, type, (event) => event.stopPropagation());
        }
        this.listen(this.canvas, "focus", () => this.focusCanvas());
        this.listen(this.root, "keydown", (event) => this.keydown(event));
        this.listen(this.canvas, "pointerdown", (event) => this.pointerDown(event));
        this.listen(this.canvas, "pointermove", (event) => this.pointerMove(event));
        this.listen(this.canvas, "pointerleave", () => { if (!this.drag) this.setHover(null); });
        this.listen(this.canvas, "pointerup", (event) => this.pointerUp(event));
        this.listen(this.canvas, "pointercancel", () => this.cancelDrag());
        this.listen(this.canvas, "lostpointercapture", () => { if (this.drag) this.cancelDrag(); });
        this.listen(this.canvas, "contextmenu", (event) => {
            event.preventDefault();
            const hit = this.hits(this.point(event), true)[0];
            if (hit) this.select(hit.id);
            this.contextMenu(event);
        });
        this.listen(this.canvas, "dblclick", () => {
            if (!this.active()) return;
            this.setTab("region");
            this.inspector.querySelector("textarea")?.focus();
        });
        this.listen(api, "executed", () => this.refreshBackground());
        this.listen(window, "resize", () => this.paint());
    }

    point(event) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
    }

    hits(point, includeLocked = false) {
        return this.regions.filter((r) => {
            if (this.hiddenIds.has(r.id)) return false;
            if (!includeLocked && this.lockedIds.has(r.id)) return false;
            return point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
        });
    }

    handles(region) {
        const { x, y, w, h } = region;
        return [["nw", x, y], ["n", x + w / 2, y], ["ne", x + w, y], ["e", x + w, y + h / 2],
            ["se", x + w, y + h], ["s", x + w / 2, y + h], ["sw", x, y + h], ["w", x, y + h / 2]];
    }

    handleAt(point) {
        const region = this.active();
        if (!region || this.hiddenIds.has(region.id) || this.lockedIds.has(region.id)) return null;
        const rect = this.canvas.getBoundingClientRect();
        const corner = this.handles(region).find(([, x, y]) => Math.abs(point.x - x) * rect.width < 9 && Math.abs(point.y - y) * rect.height < 9)?.[0];
        if (corner) return corner;
        // Edge-segment resizing along the selected box borders
        const edgeTolX = 5 / Math.max(1, rect.width);
        const edgeTolY = 5 / Math.max(1, rect.height);
        const inX = point.x >= region.x - edgeTolX && point.x <= region.x + region.w + edgeTolX;
        const inY = point.y >= region.y - edgeTolY && point.y <= region.y + region.h + edgeTolY;
        if (inX && Math.abs(point.y - region.y) <= edgeTolY) return "n";
        if (inX && Math.abs(point.y - (region.y + region.h)) <= edgeTolY) return "s";
        if (inY && Math.abs(point.x - region.x) <= edgeTolX) return "w";
        if (inY && Math.abs(point.x - (region.x + region.w)) <= edgeTolX) return "e";
        return null;
    }

    snapTargets(excludeId) {
        const xs = [0, 0.5, 1];
        const ys = [0, 0.5, 1];
        if (this.gridMode === "thirds") { xs.push(1 / 3, 2 / 3); ys.push(1 / 3, 2 / 3); }
        else if (this.gridMode === "grid") { xs.push(0.25, 0.75); ys.push(0.25, 0.75); }
        for (const r of this.regions) {
            if (r.id === excludeId || this.hiddenIds.has(r.id)) continue;
            xs.push(r.x, r.x + r.w / 2, r.x + r.w);
            ys.push(r.y, r.y + r.h / 2, r.y + r.h);
        }
        return { xs, ys };
    }

    findSnap(candidates, targets, threshold) {
        let bestDelta = 0, bestDist = threshold + 1e-9, bestLine = null;
        for (const value of candidates) {
            for (const target of targets) {
                const dist = Math.abs(target - value);
                if (dist <= bestDist) {
                    bestDist = dist;
                    bestDelta = target - value;
                    bestLine = target;
                }
            }
        }
        return bestLine !== null ? { delta: bestDelta, line: bestLine } : { delta: 0, line: null };
    }

    pointerDown(event) {
        if (event.button !== 0 || this.loadError) return;
        event.preventDefault();
        this.closeMenu();
        this.closePopovers();
        this.focusCanvas();
        const point = this.point(event);
        const forceDraw = this.tool === "draw" || event.ctrlKey || event.metaKey;
        const handle = !forceDraw && !event.altKey ? this.handleAt(point) : null;
        const hits = this.hits(point);
        if (event.altKey && hits.length) {
            const index = hits.findIndex((item) => item.id === this.selected);
            this.select(hits[(index + 1) % hits.length].id);
            return;
        }
        let region = forceDraw ? null : (handle ? this.active() : hits[0]);
        const before = JSON.stringify(plainState(this.regions));
        if (!region) {
            region = { id: uid(), x: point.x, y: point.y, w: 0, h: 0, kind: "object", text: "", description: "", relation: "", colors: [] };
            if (this.fmt.tags) region.tags = [];
            this.regions.unshift(region); // A new layer starts at the FRONT.
        }
        this.selected = region.id;
        this.guides = { x: [], y: [] };
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
            if (this.tool === "draw") {
                this.canvas.style.cursor = "crosshair";
                this.setHover(null);
                return;
            }
            const handle = this.handleAt(point);
            const hit = this.hits(point)[0];
            this.canvas.style.cursor = handle ? `${handle}-resize` : hit ? "move" : "crosshair";
            this.setHover(hit ? hit.id : null);
            return;
        }
        const active = this.active(), { region: start, origin, mode } = this.drag;
        const dx = point.x - origin.x, dy = point.y - origin.y;
        const rect = this.canvas.getBoundingClientRect();
        const tolX = 5 / Math.max(1, rect.width);
        const tolY = 5 / Math.max(1, rect.height);
        const useSnap = this.snapEnabled && !event.altKey;
        const targets = useSnap ? this.snapTargets(active.id) : null;
        const gx = [], gy = [];

        if (mode === "move") {
            let nx = clamp(start.x + dx, 0, 1 - start.w);
            let ny = clamp(start.y + dy, 0, 1 - start.h);
            if (useSnap) {
                const sx = this.findSnap([nx, nx + start.w / 2, nx + start.w], targets.xs, tolX);
                const sy = this.findSnap([ny, ny + start.h / 2, ny + start.h], targets.ys, tolY);
                if (sx.line !== null) { nx = clamp(nx + sx.delta, 0, 1 - start.w); gx.push(sx.line); }
                if (sy.line !== null) { ny = clamp(ny + sy.delta, 0, 1 - start.h); gy.push(sy.line); }
            }
            active.x = nx;
            active.y = ny;
        } else if (mode === "draw") {
            let px = point.x, py = point.y;
            if (event.shiftKey) {
                const aspect = (Number(this.value("width")) || 1) / (Number(this.value("height")) || 1);
                const vx = (px - origin.x) * aspect, vy = py - origin.y;
                const side = Math.max(Math.abs(vx), Math.abs(vy));
                px = clamp(origin.x + (vx < 0 ? -1 : 1) * (side / aspect), 0, 1);
                py = clamp(origin.y + (vy < 0 ? -1 : 1) * side, 0, 1);
            } else if (useSnap) {
                const sx = this.findSnap([px], targets.xs, tolX);
                const sy = this.findSnap([py], targets.ys, tolY);
                if (sx.line !== null) { px = sx.line; gx.push(sx.line); }
                if (sy.line !== null) { py = sy.line; gy.push(sy.line); }
            }
            Object.assign(active, { x: Math.min(origin.x, px), y: Math.min(origin.y, py), w: Math.abs(px - origin.x), h: Math.abs(py - origin.y) });
        } else {
            let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
            if (mode.includes("w")) left = clamp(start.x + dx, 0, right - 0.001);
            if (mode.includes("e")) right = clamp(start.x + start.w + dx, left + 0.001, 1);
            if (mode.includes("n")) top = clamp(start.y + dy, 0, bottom - 0.001);
            if (mode.includes("s")) bottom = clamp(start.y + start.h + dy, top + 0.001, 1);

            const isCorner = (mode.includes("w") || mode.includes("e")) && (mode.includes("n") || mode.includes("s"));
            if (event.shiftKey && isCorner && start.h > 0 && start.w > 0) {
                const aspect = (Number(this.value("width")) || 1) / (Number(this.value("height")) || 1);
                const startRatio = (start.w * aspect) / start.h;
                let w = right - left, h = (w * aspect) / startRatio;
                if (mode.includes("n")) {
                    top = bottom - h;
                    if (top < 0) { top = 0; h = bottom; w = (h * startRatio) / aspect; left = mode.includes("w") ? right - w : left; right = mode.includes("e") ? left + w : right; }
                } else {
                    bottom = top + h;
                    if (bottom > 1) { bottom = 1; h = 1 - top; w = (h * startRatio) / aspect; left = mode.includes("w") ? right - w : left; right = mode.includes("e") ? left + w : right; }
                }
            } else if (useSnap) {
                if (mode.includes("w")) { const sx = this.findSnap([left], targets.xs, tolX); if (sx.line !== null) { left = clamp(sx.line, 0, right - 0.001); gx.push(sx.line); } }
                if (mode.includes("e")) { const sx = this.findSnap([right], targets.xs, tolX); if (sx.line !== null) { right = clamp(sx.line, left + 0.001, 1); gx.push(sx.line); } }
                if (mode.includes("n")) { const sy = this.findSnap([top], targets.ys, tolY); if (sy.line !== null) { top = clamp(sy.line, 0, bottom - 0.001); gy.push(sy.line); } }
                if (mode.includes("s")) { const sy = this.findSnap([bottom], targets.ys, tolY); if (sy.line !== null) { bottom = clamp(sy.line, top + 0.001, 1); gy.push(sy.line); } }
            }
            Object.assign(active, { x: left, y: top, w: Math.max(0.001, right - left), h: Math.max(0.001, bottom - top) });
        }
        this.guides = { x: gx, y: gy };
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
        this.guides = { x: [], y: [] };
        this.activeTab = this.selected ? "region" : "scene";
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
        this.recordHistory();
        this.changed(); this.notifyGraph();
    }

    cancelDrag() {
        if (!this.drag) return;
        this.regions = readRegions(this.drag.before);
        this.drag = null;
        this.guides = { x: [], y: [] };
        if (!this.active()) { this.selected = null; this.activeTab = "scene"; }
        this.changed();
    }

    keydown(event) {
        if (event.target !== this.focusSink && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
        const modifier = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
        if (key === "escape") { this.cancelDrag(); this.closeMenu(); this.closePopovers(); this.select(null); return; }
        if (this.drag) return;
        if (modifier && key === "z") { event.preventDefault(); if (event.shiftKey) this.redo(); else this.undo(); return; }
        if (modifier && key === "y") { event.preventDefault(); this.redo(); return; }
        if (!modifier && key === "v") { event.preventDefault(); this.setTool("select"); return; }
        if (!modifier && key === "r") { event.preventDefault(); this.setTool("draw"); return; }
        if (key === "delete" || key === "backspace") { event.preventDefault(); this.remove(); return; }
        if (modifier && key === "c" && this.active()) { event.preventDefault(); copiedRegion = plainRegion(this.active()); return; }
        if (modifier && key === "v" && copiedRegion) { event.preventDefault(); this.pasteRegion(copiedRegion); return; }
        if (modifier && key === "d" && this.active()) { event.preventDefault(); this.duplicate(); return; }

        // Arrow-key nudging for fine layout positioning
        if (["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
            const region = this.active();
            if (!region || this.lockedIds.has(region.id)) return;
            event.preventDefault();
            const step = event.shiftKey ? 0.025 : 0.005;
            if (key === "arrowleft") region.x = clamp(region.x - step, 0, 1 - region.w);
            if (key === "arrowright") region.x = clamp(region.x + step, 0, 1 - region.w);
            if (key === "arrowup") region.y = clamp(region.y - step, 0, 1 - region.h);
            if (key === "arrowdown") region.y = clamp(region.y + step, 0, 1 - region.h);
            this.recordHistory();
            this.changed(); this.notifyGraph();
        }
    }

    pasteRegion(source) {
        const region = plainRegion(source);
        region.id = uid();
        region.x = Math.min(1 - region.w, region.x + 0.025);
        region.y = Math.min(1 - region.h, region.y + 0.025);
        this.regions.unshift(region);
        this.selected = region.id;
        this.activeTab = "region";
        this.recordHistory();
        this.changed(); this.notifyGraph();
    }

    duplicate() { if (this.active()) this.pasteRegion(this.active()); }

    remove() {
        if (!this.active()) return;
        const id = this.selected;
        this.regions = this.regions.filter((region) => region.id !== id);
        this.lockedIds.delete(id);
        this.hiddenIds.delete(id);
        this.selected = null;
        this.activeTab = "scene";
        this.recordHistory();
        this.changed(); this.notifyGraph();
    }

    reorder(from, to) {
        if (to < 0 || to >= this.regions.length || from === to) return;
        const [region] = this.regions.splice(from, 1);
        this.regions.splice(to, 0, region);
        this.recordHistory();
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
        const region = this.active();
        const items = [
            ["Bring forward", () => this.moveLayer(-1)],
            ["Send backward", () => this.moveLayer(1)],
            ["Duplicate layer", () => this.duplicate()],
            ...(region ? [
                [this.lockedIds.has(region.id) ? "Unlock layer" : "Lock layer", () => this.toggleLocked(region.id)],
                [this.hiddenIds.has(region.id) ? "Show layer" : "Hide layer", () => this.toggleHidden(region.id)],
            ] : []),
            ["Delete layer", () => this.remove()],
            [`Copy ${this.fmt.json}`, () => this.copyJSON()],
            [`Import ${this.fmt.json}`, () => this.jsonDialog()],
        ];
        for (const [label, action] of items) {
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
        const approved = await app.extensionManager.dialog.confirm({ title: `Clear ${this.fmt.brand[0]} regions`,
            message: this.loadError ? "Discard the invalid editor state and start again?" : `Remove all ${this.regions.length} regions?` });
        if (!approved) return;
        this.regions = []; this.selected = null; this.activeTab = "scene";
        this.lockedIds.clear(); this.hiddenIds.clear(); this.loadError = false;
        this.recordHistory();
        this.changed(); this.notifyGraph();
    }

    async copyJSON() {
        if (this.connected("import_json")) throw new Error("Disconnect import_json or import its value into the editor before copying JSON.");
        const result = await request(this.fmt.route, "serialize", this.payload());
        try {
            await navigator.clipboard.writeText(result.prompt);
            this.message(`${this.fmt.json} copied.` + (result.warnings.length ? ` ${result.warnings.join(" ")}` : ""), result.warnings.length ? "warning" : "info");
        } catch (error) {
            // Clipboard permission/HTTP failures remain usable with an ordinary text selection.
            this.jsonDialog(result.prompt, true);
            this.message(`Clipboard unavailable (${error.message}). Copy from the open JSON field.`, "warning");
        }
    }

    jsonDialog(initial = this.value("import_json") || "", readOnly = false) {
        this.dialog?.remove();
        const dialog = element("dialog", "ming-builder ming-json-dialog");
        const heading = element("h3", "", readOnly ? this.fmt.json : `Import ${this.fmt.json}`);
        const text = element("textarea");
        text.value = initial; text.readOnly = readOnly; text.spellcheck = false;
        text.setAttribute("aria-label", this.fmt.json);
        const help = element("p", "ming-help", readOnly ? "Select all and copy the complete prompt." : this.fmt.ui === "moss"
            ? "Import replaces regions and summary. A model prompt is read on the current width × height; an editable draft (abs/xyxy) or plain caption also works."
            : "Import replaces regions and canvas settings. The editor keeps the imported aspect ratio.");
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
                    const result = await request(this.fmt.route, "import", { prompt: text.value, width: Number(this.value("width")), height: Number(this.value("height")) });
                    this.applyImport(result);
                    field(this.node, "import_json").value = "";
                    this.recordHistory();
                    this.changed(); this.notifyGraph();
                    dialog.close();
                } catch (failure) { error.textContent = failure.message; }
            }, "Import into editor", "ming-button ming-btn-primary"));
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
        this.selected = null; this.hovered = null; this.activeTab = "scene";
        this.lockedIds.clear(); this.hiddenIds.clear(); this.loadError = false;
        for (const name of this.fmt.canvas) field(this.node, name).value = result[name];
        this.syncSettings();
        this.updateTabs();
    }

    executed(output) {
        const result = output?.[this.fmt.ui]?.[0];
        if (!result) return;
        if (this.queuedRevision !== undefined && this.revision !== this.queuedRevision) {
            this.message("Execution finished using earlier inputs. Your newer editor changes were kept.");
            return;
        }
        if (result.regions) { this.applyImport(result); this.recordHistory(); }
        else for (const name of this.fmt.canvas) field(this.node, name).value = result[name];
        for (const name of ["bg_brightness", "output_format"]) field(this.node, name).value = result[name];
        this.executedBackground = output.ming_background?.[0] || "";
        this.loadBackground(this.executedBackground);
        this.syncSettings(); this.persist(); this.updateTabs(); this.renderLayers(); this.renderInspector();
        this.message(result.warnings.length ? result.warnings.join("\n") : `${this.fmt.brand[0] === "MING" ? "Ming" : "MOSS"} prompt and layout preview ready.`, result.warnings.length ? "warning" : "info");
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
        this.brightnessLabel?.classList.toggle("inactive", !this.connected("image") && !source);
        if (!source) { this.paint(); return; }
        const image = new Image();
        image.onload = () => {
            if (this.backgroundSource !== source || this.destroyed) return;
            this.background = image;
            this.brightnessLabel?.classList.remove("inactive");
            this.paint();
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

    drawGrid(ctx, width, height) {
        if (this.gridMode === "off") return;
        const steps = this.gridMode === "thirds" ? 3 : 4;
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
        ctx.lineWidth = 1;
        for (let i = 1; i < steps; i++) {
            const x = (width * i) / steps;
            const y = (height * i) / steps;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        }
        // Subtle center crosshair
        ctx.strokeStyle = "rgba(125, 180, 255, 0.18)";
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
        ctx.restore();
    }

    draw() {
        const availableW = this.stage.clientWidth - 20, availableH = this.stage.clientHeight - 20;
        if (availableW < 1 || availableH < 1) return;
        const canvasW = Number(this.value("width")) || 1024;
        const canvasH = Number(this.value("height")) || 1024;
        const aspect = canvasW / canvasH || 1;
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

        this.drawGrid(ctx, width, height);

        if (!this.regions.length) {
            ctx.fillStyle = "#8a97ab"; ctx.textAlign = "center"; ctx.font = "12.5px system-ui, sans-serif";
            ctx.fillText("Drag anywhere to draw a region", width / 2, height / 2);
        }

        const placedTags = [];
        // Painter's order is BACK -> FRONT, although the editor list is FRONT -> BACK.
        for (let i = this.regions.length - 1; i >= 0; i--) {
            const region = this.regions[i];
            if (this.hiddenIds.has(region.id)) continue;
            const x = region.x * width, y = region.y * height, w = region.w * width, h = region.h * height;
            const color = this.regionColor(region);
            const isHovered = region.id === this.hovered;
            const isSelected = region.id === this.selected;
            const isLocked = this.lockedIds.has(region.id);

            ctx.globalAlpha = isSelected ? 0.13 : isHovered ? 0.11 : 0.06;
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;

            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = isHovered ? 2 : 1.5;
            if (isLocked) ctx.setLineDash([4, 3]);
            ctx.strokeRect(x, y, w, h);
            ctx.restore();

            // Soft in-box text preview for Text layers
            if (region.kind === "text" && region.text.trim() && w >= 42 && h >= 28) {
                ctx.save();
                const contentTop = y + 18;
                const contentH = Math.max(0, h - 20);
                ctx.beginPath();
                ctx.rect(x + 4, contentTop, Math.max(0, w - 8), contentH);
                ctx.clip();
                const previewLine = region.text.replace(/\s+/g, " ").trim();
                const fontSize = clamp(Math.round(Math.min(contentH * 0.62, 18)), 10, 18);
                ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
                ctx.fillStyle = "rgba(244, 247, 252, 0.72)";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(previewLine, x + w / 2, contentTop + contentH / 2, Math.max(10, w - 12));
                ctx.restore();
            }

            // Smart tag pill with snippet & collision avoidance
            const num = String(this.regions.length - i).padStart(2, "0");
            const rawSnippet = (region.kind === "text" ? region.text : region.description).replace(/\s+/g, " ").trim();
            const shortSnippet = rawSnippet ? ` · ${rawSnippet.slice(0, 18)}${rawSnippet.length > 18 ? "…" : ""}` : "";
            const lockMark = isLocked ? " [locked]" : "";
            const baseTag = `${num} ${this.kindTag(region.kind)}${lockMark}`;
            const fullTag = `${num} ${this.kindTag(region.kind)}${shortSnippet}${lockMark}`;

            ctx.font = "600 10px system-ui, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            const fullW = ctx.measureText(fullTag).width + 10;
            const useFull = rawSnippet && fullW <= Math.max(w - 4, 90) && fullW < width - 8;
            const tag = useFull ? fullTag : baseTag;
            const tagW = Math.min(width, ctx.measureText(tag).width + 10);
            const tagH = 17;
            let tagX = clamp(x, 0, Math.max(0, width - tagW));
            let tagY = clamp(y, 0, Math.max(0, height - tagH));
            for (let attempt = 0; attempt < 4; attempt++) {
                const candidate = { x: tagX, y: tagY, w: tagW, h: tagH };
                if (!placedTags.some((other) => rectsOverlap(candidate, other))) break;
                tagY = clamp(tagY + tagH + 2, 0, Math.max(0, height - tagH));
            }
            placedTags.push({ x: tagX, y: tagY, w: tagW, h: tagH });
            ctx.fillStyle = "rgba(16, 20, 28, 0.90)";
            ctx.fillRect(tagX, tagY, tagW, tagH);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(tagX, tagY, tagW, tagH);
            ctx.fillStyle = "#F4F7FC";
            ctx.fillText(tag, tagX + 5, tagY + 12);
        }

        // Smart alignment guide lines during drag
        if (this.drag && (this.guides.x.length || this.guides.y.length)) {
            ctx.save();
            ctx.strokeStyle = "#F472B6";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            for (const gx of this.guides.x) {
                ctx.beginPath(); ctx.moveTo(gx * width, 0); ctx.lineTo(gx * width, height); ctx.stroke();
            }
            for (const gy of this.guides.y) {
                ctx.beginPath(); ctx.moveTo(0, gy * height); ctx.lineTo(width, gy * height); ctx.stroke();
            }
            ctx.restore();
        }

        // Selected outline & handles
        const selected = this.active();
        if (selected) {
            const sx = selected.x * width, sy = selected.y * height, sw = selected.w * width, sh = selected.h * height;
            const isHidden = this.hiddenIds.has(selected.id);
            const isLocked = this.lockedIds.has(selected.id);
            ctx.save();
            ctx.strokeStyle = isHidden ? "rgba(255, 255, 255, 0.45)" : "#FFFFFF";
            ctx.lineWidth = isHidden ? 1.5 : 2;
            if (isHidden || isLocked) ctx.setLineDash([5, 4]);
            ctx.strokeRect(sx, sy, sw, sh);
            ctx.restore();
            if (!isHidden && !isLocked) {
                for (const [, hx, hy] of this.handles(selected)) {
                    ctx.fillStyle = "#FFFFFF";
                    ctx.fillRect(hx * width - 3.5, hy * height - 3.5, 7, 7);
                    ctx.strokeStyle = "#0F172A";
                    ctx.lineWidth = 1;
                    ctx.strokeRect(hx * width - 3.5, hy * height - 3.5, 7, 7);
                }
            }
            // Live drag HUD readout
            if (this.drag && selected.w > 0 && selected.h > 0) {
                const pxW = Math.round(selected.w * canvasW), pxH = Math.round(selected.h * canvasH);
                const pxX = Math.round(selected.x * canvasW), pxY = Math.round(selected.y * canvasH);
                const hud = this.drag.mode === "move"
                    ? `x ${pxX}, y ${pxY} px`
                    : `${pxW} × ${pxH} px · ${selected.w.toFixed(2)}×${selected.h.toFixed(2)}`;
                ctx.font = "600 10.5px ui-monospace, SFMono-Regular, monospace";
                const hudW = ctx.measureText(hud).width + 12;
                const hudH = 20;
                const hudX = clamp(sx + sw / 2 - hudW / 2, 4, Math.max(4, width - hudW - 4));
                const hudY = sy + sh + 6 + hudH <= height ? sy + sh + 6 : clamp(sy - hudH - 6, 4, height - hudH - 4);
                ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
                ctx.fillRect(hudX, hudY, hudW, hudH);
                ctx.strokeStyle = "rgba(125, 180, 255, 0.65)";
                ctx.lineWidth = 1;
                ctx.strokeRect(hudX, hudY, hudW, hudH);
                ctx.fillStyle = "#F8FAFC";
                ctx.textAlign = "left";
                ctx.textBaseline = "alphabetic";
                ctx.fillText(hud, hudX + 6, hudY + 13.5);
            }
        }
    }

    destroy() {
        this.destroyed = true;
        this.events.abort(); this.validationRequest?.abort();
        clearTimeout(this.validationTimer); cancelAnimationFrame(this.paintFrame);
        this.resizeObserver.disconnect(); this.closeMenu(); this.closePopovers(); this.dialog?.remove();
        this.background = null; this.root.remove();
        EDITORS.delete(this.node);
    }
}

app.registerExtension({
    name: "MingImage.PromptBuilder",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const format = FORMATS[nodeData.name];
        if (!format) return;
        if (!document.querySelector("link[data-ming-builder]")) {
            const stylesheet = element("link");
            stylesheet.rel = "stylesheet";
            stylesheet.href = new URL("ming_prompt_builder.css", import.meta.url).href;
            stylesheet.dataset.mingBuilder = "true";
            document.head.append(stylesheet);
        }
        chain(nodeType.prototype, "onNodeCreated", function () {
            EDITORS.set(this, new MingEditor(this, format));
            this.resizable = true;
            this.size = [920, 740];
        });
    },
    loadedGraphNode(node) {
        if (FORMATS[node.comfyClass]) EDITORS.get(node)?.refreshBackground();
    },
});
