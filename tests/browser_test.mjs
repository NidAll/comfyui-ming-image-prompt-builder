// Run against a dedicated ComfyUI test server, never a user's active workflow.
// Requires Playwright as a development-only dependency and a Chromium browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.argv[2] || "http://127.0.0.1:8197";
const output = process.env.MING_TEST_OUTPUT || new URL("../test-results/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.MING_BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
// This test only needs localhost. Do not contact external telemetry or asset hosts.
await page.route("**/*", (route) => {
    const url = route.request().url();
    return url.startsWith(base) || url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort();
});

const state = () => page.evaluate(() => {
    const node = window.comfyAPI.app.app.graph._nodes.find((n) => n.comfyClass === "MingImagePromptBuilder");
    return JSON.parse(node.widgets.find((w) => w.name === "layers_data").value);
});
const canvas = () => page.locator(".ming-canvas");
async function point(x, y) {
    // Manual mouse coordinates do not receive Playwright's locator stability
    // checks. Let ComfyUI's Vue layout + ResizeObserver paint before measuring.
    await canvas().evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await canvas().boundingBox();
    return { x: box.x + x * box.width, y: box.y + y * box.height };
}
async function drag(from, to, modifier) {
    const a = await point(...from), b = await point(...to);
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
    if (modifier) await page.keyboard.up(modifier);
}
async function apiPost(route, value) {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
}
async function until(fn, message, milliseconds = 30000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        const result = await fn();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(message);
}

try {
    await page.goto(base);
    await page.waitForFunction(() => window.comfyAPI?.app?.app?.graph && window.LiteGraph?.registered_node_types?.MingImagePromptBuilder, { timeout: 60000 });
    // Registration precedes ComfyUI's asynchronous default-workflow restoration.
    await page.waitForFunction(() => window.comfyAPI.app.app.graph._nodes.length > 0);
    await page.evaluate(async (vue) => window.comfyAPI.app.app.extensionManager.setting.set("Comfy.VueNodes.Enabled", vue), process.env.MING_TEST_VUE === "1");
    await page.evaluate(() => {
        const app = window.comfyAPI.app.app;
        app.graph.clear();
        const node = LiteGraph.createNode("MingImagePromptBuilder");
        app.graph.add(node); node.pos = [35, 50];
        app.canvas.ds.scale = 1; app.canvas.ds.offset = [0, 0]; app.canvas.setDirty(true, true);
    });
    await canvas().waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(output, "empty-editor.png") });
    console.log("PASS node registration and visible editor");

    await drag([.2, .15], [.8, .35]);
    assert.equal((await state()).regions.length, 1);
    const drawn = (await state()).regions[0];
    assert.deepEqual(drawn.colors, []); // The editor's fallback outline color is not a prompt instruction.
    assert.ok(Math.abs(drawn.x - .2) < .01 && Math.abs(drawn.y - .15) < .01);
    assert.ok(Math.abs(drawn.w - .6) < .01 && Math.abs(drawn.h - .2) < .01, JSON.stringify(drawn));
    await page.getByRole("textbox", { name: "Description", exact: true }).fill("bold condensed editorial typography");
    await page.getByRole("textbox", { name: "Hierarchy / Relation", exact: true }).fill("Primary headline above the central subject.");
    assert.equal(await page.getByRole("textbox", { name: "Exact Text", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Text", exact: true }).click();
    const exact = '  FUTURE "MEMORY" \\ {left|right}\n未来 — مرحبًا  ';
    await page.getByRole("textbox", { name: "Exact Text", exact: true }).fill(exact);
    assert.equal((await state()).regions[0].text, exact);
    console.log("PASS draw, object/text toggle, exact Unicode and whitespace");

    await canvas().focus();
    await page.keyboard.press("Control+c"); await page.keyboard.press("Control+v");
    assert.equal((await state()).regions.length, 2);
    await page.keyboard.press("Control+d"); assert.equal((await state()).regions.length, 3);
    await page.keyboard.press("Delete"); assert.equal((await state()).regions.length, 2);
    await page.locator(".ming-layer").first().click();
    await canvas().focus(); await page.keyboard.press("Backspace");
    assert.equal((await state()).regions.length, 1);
    console.log("PASS copy, paste, duplicate, Delete and Backspace");

    await page.locator(".ming-layer").first().click();
    const beforeMove = (await state()).regions[0];
    await drag([beforeMove.x + beforeMove.w / 2, beforeMove.y + beforeMove.h / 2],
        [beforeMove.x + beforeMove.w / 2 + .08, beforeMove.y + beforeMove.h / 2 + .07]);
    const moved = (await state()).regions[0];
    assert.equal((await state()).regions.length, 1);
    assert.ok(moved.x > beforeMove.x + .06, JSON.stringify({ beforeMove, moved }));
    await drag([moved.x + moved.w, moved.y + moved.h], [.95, .55]);
    const resized = (await state()).regions[0];
    assert.equal((await state()).regions.length, 1);
    assert.ok(resized.w > moved.w && resized.h > moved.h);
    assert.ok(resized.x + resized.w <= 1.000001);
    console.log("PASS move and resize with normalized geometry");

    await drag([.4, .25], [.75, .48], "Control");
    await page.getByRole("textbox", { name: "Description", exact: true }).fill("A sculptural red ceramic bowl.");
    await page.getByRole("textbox", { name: "Hierarchy / Relation", exact: true }).fill("Central subject below the title.");
    const order = (await state()).regions.map((r) => r.id);
    await page.getByRole("button", { name: "↓ Back", exact: true }).click();
    assert.deepEqual((await state()).regions.map((r) => r.id), [...order].reverse());
    const overlap = await point(.5, .35);
    await page.keyboard.down("Alt"); await page.mouse.click(overlap.x, overlap.y); await page.keyboard.up("Alt");
    assert.equal(await page.locator('.ming-layer[aria-selected="true"]').count(), 1);
    await page.locator(".ming-layer").first().dragTo(page.locator(".ming-layer").last());
    assert.deepEqual((await state()).regions.map((r) => r.id), order);
    console.log("PASS forced drawing, overlap cycling, button and drag layer ordering");

    await page.locator(".ming-layer").first().click();
    await page.getByRole("button", { name: "+ Color", exact: true }).click();
    await page.getByRole("button", { name: "+ Color", exact: true }).click();
    await page.getByRole("textbox", { name: "Color hex 2", exact: true }).fill("#a1b2c3");
    assert.equal((await state()).regions[0].colors[1], "#A1B2C3");
    await page.getByRole("textbox", { name: "Color hex 2", exact: true }).fill("#BAD");
    await page.waitForFunction(() => document.querySelector('.ming-status')?.textContent.includes("invalid color"));
    await page.getByRole("textbox", { name: "Color hex 2", exact: true }).fill("#A1B2C3");
    console.log("PASS multiple swatches, normalization and validation");

    await page.locator(".ming-layer").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy Ming JSON", exact: true }).click();
    const copied = await until(async () => {
        const value = await page.evaluate(() => navigator.clipboard.readText());
        return value.startsWith("{") && value;
    }, "JSON was not copied");
    const prompt = JSON.parse(copied);
    assert.equal(prompt.layers.length, 2);
    assert.ok(prompt.layers.some((layer) => layer.description.includes(exact)));
    assert.deepEqual(Object.keys(prompt), ["canvas_settings", "layers"]);
    console.log("PASS context menu and authoritative JSON copy");

    const originalDescription = prompt.layers[0].description;
    prompt.canvas_settings.aspect_ratio = "3:2";
    prompt.canvas_settings.image_style = "modern editorial poster";
    prompt.canvas_settings.ambient_lighting = "soft studio lighting";
    await page.getByRole("button", { name: "Import JSON", exact: true }).click();
    await page.getByRole("textbox", { name: "Ming JSON", exact: true }).fill(JSON.stringify(prompt));
    await page.getByRole("button", { name: "Import into editor", exact: true }).click();
    await page.locator(".ming-json-dialog").waitFor({ state: "detached" });
    assert.equal((await state()).regions.length, 2);
    assert.equal(await page.getByRole("textbox", { name: "Image Style", exact: true }).inputValue(), "modern editorial poster");
    await page.getByRole("button", { name: "Import JSON", exact: true }).click();
    await page.getByRole("textbox", { name: "Ming JSON", exact: true }).fill('{"layers":');
    await page.getByRole("button", { name: "Import into editor", exact: true }).click();
    await page.locator(".ming-dialog-error").filter({ hasText: "Ming JSON" }).waitFor();
    assert.equal((await state()).regions.length, 2);
    await page.locator(".ming-json-dialog").getByRole("button", { name: "Close", exact: true }).click();
    console.log("PASS JSON import, aspect/style population and non-destructive errors");

    // Test proxies with real browser objects present: only the explicit schema survives.
    await page.evaluate(async () => {
        const module = await import("/extensions/ComfyUI-Ming-Image-Prompt-Builder/ming_prompt_builder.js");
        const source = new Proxy({ id: "proxy", kind: "text", text: "exact", description: "plain", relation: "front",
            x: .1, y: .1, w: .8, h: .2, colors: new Proxy(["#FFFFFF"], {}), canvas: document.createElement("canvas"), hover: true }, {});
        const result = module.plainState(new Proxy([source], {}));
        structuredClone(result);
        if ("canvas" in result.regions[0] || "hover" in result.regions[0]) throw new Error("Transient state leaked");
    });
    const before = await state();
    const serialized = await page.evaluate(async () => window.comfyAPI.app.app.graphToPrompt());
    assert.ok(!JSON.stringify(serialized.workflow).includes("_preview_selected"));
    assert.ok(!JSON.stringify(serialized.workflow).includes("canvasContext"));
    await page.evaluate(async (workflow) => window.comfyAPI.app.app.loadGraphData(workflow), serialized.workflow);
    await canvas().waitFor({ state: "visible" });
    assert.deepEqual(await state(), before);
    assert.equal(await page.locator('.ming-layer[aria-selected="true"]').count(), 0);
    console.log("PASS Proxy safety and JSON workflow round trip without selection persistence");

    await page.evaluate(() => {
        const app = window.comfyAPI.app.app;
        const builder = app.graph._nodes.find((node) => node.comfyClass === "MingImagePromptBuilder");
        const save = LiteGraph.createNode("SaveImage"); app.graph.add(save);
        save.widgets.find((widget) => widget.name === "filename_prefix").value = "MingBuilderTest";
        save.pos = [980, 100]; builder.connect(1, save, 0);
        app.canvas.setDirty(true, true);
    });
    const graph = await page.evaluate(async () => window.comfyAPI.app.app.graphToPrompt());
    const queued = await apiPost("/prompt", { prompt: graph.output, extra_data: { extra_pnginfo: { workflow: graph.workflow } } });
    const history = await until(async () => {
        const data = await (await fetch(`${base}/history/${queued.prompt_id}`)).json();
        return data[queued.prompt_id];
    }, "Preview execution did not finish");
    assert.equal(history.status.status_str, "success", JSON.stringify(history.status));
    const images = Object.values(history.outputs).flatMap((value) => value.images || []);
    assert.equal(images.length, 1);
    const image = images[0];
    const url = `${base}/view?${new URLSearchParams(image)}`;
    const png = await (await fetch(url)).arrayBuffer();
    await writeFile(path.join(output, "workflow.png"), Buffer.from(png));
    await page.evaluate(async (url) => {
        const app = window.comfyAPI.app.app;
        const blob = await (await fetch(url)).blob();
        app.graph.clear();
        await app.handleFile(new File([blob], "ming-workflow.png", { type: "image/png" }));
    }, url);
    await canvas().waitFor({ state: "visible" });
    assert.deepEqual(await state(), before);
    const afterPNG = await page.evaluate(async () => window.comfyAPI.app.app.graphToPrompt());
    const builder = Object.values(afterPNG.output).find((node) => node.class_type === "MingImagePromptBuilder");
    const checked = await apiPost("/ming_prompt_builder/serialize", builder.inputs);
    assert.equal(JSON.parse(checked.prompt).layers[0].description, originalDescription);
    console.log("PASS actual SaveImage PNG execution and frontend PNG workflow reload");

    // Resize the node and zoom without changing its normalized geometry or aspect.
    const geometryBeforeResize = await state();
    await page.evaluate(() => {
        const app = window.comfyAPI.app.app;
        const node = app.graph._nodes.find((n) => n.comfyClass === "MingImagePromptBuilder");
        node.setSize([950, 980]); app.canvas.ds.scale = .9; app.canvas.setDirty(true, true);
    });
    await until(async () => {
        const box = await canvas().boundingBox();
        return Math.abs(box.width / box.height - 1.5) < .01;
    }, "Canvas aspect ratio did not survive node resize");
    assert.deepEqual(await state(), geometryBeforeResize);
    console.log("PASS node resizing, zoom and high-DPI aspect accuracy");

    // A generic IMAGE provider only becomes available after execution.
    await page.evaluate(() => {
        const app = window.comfyAPI.app.app;
        const builder = app.graph._nodes.find((n) => n.comfyClass === "MingImagePromptBuilder");
        const background = LiteGraph.createNode("EmptyImage"); app.graph.add(background);
        for (const [name, value] of Object.entries({ width: 64, height: 32, batch_size: 2, color: 16777215 })) {
            background.widgets.find((w) => w.name === name).value = value;
        }
        background.pos = [1200, 700]; background.connect(0, builder, builder.inputs.findIndex((i) => i.name === "image"));
        builder.widgets.find((w) => w.name === "bg_brightness").value = 100;
    });
    const backgroundGraph = await page.evaluate(async () => window.comfyAPI.app.app.graphToPrompt());
    const clientId = await page.evaluate(() => window.comfyAPI.api.api.clientId);
    const backgroundJob = await apiPost("/prompt", { client_id: clientId, prompt: backgroundGraph.output, extra_data: { extra_pnginfo: { workflow: backgroundGraph.workflow } } });
    const backgroundHistory = await until(async () => (await (await fetch(`${base}/history/${backgroundJob.prompt_id}`)).json())[backgroundJob.prompt_id], "Background execution failed");
    assert.equal(backgroundHistory.status.status_str, "success");
    const sampleBackground = () => canvas().evaluate((canvas) => {
        const rgba = canvas.getContext("2d").getImageData(Math.round(canvas.width * .03), Math.round(canvas.height * .7), 1, 1).data;
        return rgba[0];
    });
    await until(async () => (await sampleBackground()) > 240, "Background was not delivered to editor");
    await page.getByRole("slider", { name: "Background brightness" }).evaluate((input) => {
        input.value = "25"; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(async () => { const value = await sampleBackground(); return value > 50 && value < 80; }, "Brightness slider did not dim the background");
    console.log("PASS IMAGE background, batched execution and live brightness");

    // Exercise the shipped example, not just the test's constructed graph.
    const example = JSON.parse(await readFile(new URL("../example_workflows/ming_prompt_builder.json", import.meta.url), "utf8"));
    await page.evaluate(async (workflow) => window.comfyAPI.app.app.loadGraphData(workflow), example);
    await canvas().waitFor({ state: "visible" });
    assert.equal((await state()).regions.length, 3);
    const exampleGraph = await page.evaluate(async () => window.comfyAPI.app.app.graphToPrompt());
    const exampleJob = await apiPost("/prompt", { client_id: clientId, prompt: exampleGraph.output, extra_data: { extra_pnginfo: { workflow: exampleGraph.workflow } } });
    const exampleHistory = await until(async () => (await (await fetch(`${base}/history/${exampleJob.prompt_id}`)).json())[exampleJob.prompt_id], "Example execution failed");
    assert.equal(exampleHistory.status.status_str, "success");
    assert.equal(JSON.parse(exampleHistory.outputs["3"].text[0]).layers.length, 3);
    console.log("PASS bundled example with official PreviewImage and PreviewAny");

    const cloneCheck = await page.evaluate(() => {
        const app = window.comfyAPI.app.app;
        const original = app.graph._nodes.find((n) => n.comfyClass === "MingImagePromptBuilder");
        const clone = original.clone(); app.graph.add(clone); clone.pos = [2000, 100];
        const data = clone.serialize();
        data.properties.ming_prompt_builder.regions[0].text = "CLONE ONLY";
        clone.configure(data);
        const state = (node) => JSON.parse(node.widgets.find((w) => w.name === "layers_data").value);
        const results = { original: state(original).regions[0].text, clone: state(clone).regions[0].text };
        app.graph.remove(clone);
        return results;
    });
    assert.deepEqual(cloneCheck, { original: "FUTURE MEMORY", clone: "CLONE ONLY" });
    console.log("PASS node cloning keeps independent JSON-safe region state");

    const beforeDragSave = await state();
    const start = await point(.1, .8), end = await point(.3, .9);
    await page.keyboard.down("Control");
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    const duringDrag = await page.evaluate(async () => window.comfyAPI.app.app.graphToPrompt());
    const savedBuilder = duringDrag.workflow.nodes.find((n) => n.type === "MingImagePromptBuilder");
    assert.deepEqual(savedBuilder.properties.ming_prompt_builder.regions, beforeDragSave.regions);
    await page.keyboard.press("Escape"); await page.mouse.up(); await page.keyboard.up("Control");
    assert.deepEqual(await state(), beforeDragSave);
    console.log("PASS an unfinished drag is excluded from workflow serialization");

    await page.locator(".ming-layer").first().click();
    await page.screenshot({ path: path.join(output, "editor.png") });
    await page.locator(".ming-builder").first().screenshot({ path: path.join(output, "editor-crop.png") });
    await writeFile(path.join(output, "workflow.json"), JSON.stringify(afterPNG.workflow, null, 2));
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Clear Ming regions" });
    await confirm.waitFor();
    await confirm.getByRole("button", { name: /confirm|yes|delete|clear/i }).click();
    await until(async () => (await state()).regions.length === 0, "Clear all did not remove regions");
    console.log("PASS clear all with confirmation");
    assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
    console.log("PASS no browser errors; screenshots and PNG saved to", output);
} catch (error) {
    await page.screenshot({ path: path.join(output, "failure.png") });
    console.error("Browser errors:", errors);
    console.error("Visible page:", (await page.locator("body").innerText()).slice(0, 5000));
    throw error;
} finally {
    await browser.close();
}
