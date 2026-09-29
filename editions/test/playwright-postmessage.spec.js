const{ test, expect } = require("@playwright/test");
const{resolve} = require("path");
const http = require("http");
const fs = require("fs");
const url = require("url");

// Each scenario boots a full TiddlyWiki inside an iframe; keep them serial to
// avoid several simultaneous 4 MB wikis contending in a headless browser.
test.describe.configure({mode: "serial"});

const outputDir = resolve(__dirname, "output");
const fixturesDir = resolve(__dirname, "fixtures");

/*
Minimal static file server covering the built test wiki and the host fixture.
Each parallel worker binds its own ephemeral port.
*/
let server;
let baseUrl;
test.beforeAll(async () => {
	baseUrl = await new Promise(resolvePromise => {
		server = http.createServer((request,response) => {
			const pathname = decodeURIComponent(url.parse(request.url).pathname);
			let file;
			if(pathname === "/" || pathname === "/test.html") {
				file = resolve(outputDir,"test.html");
			} else if(pathname === "/host.html") {
				file = resolve(fixturesDir,"host.html");
			} else {
				response.statusCode = 404;
				response.end("not found");
				return;
			}
			fs.readFile(file,(err,data) => {
				if(err) {
					response.statusCode = 404;
					response.end("not found");
					return;
				}
				response.setHeader("Content-Type",file.endsWith(".html") ? "text/html" : "application/octet-stream");
				response.end(data);
			});
		});
		server.listen(0,"127.0.0.1",() => {
			resolvePromise("http://127.0.0.1:" + server.address().port);
		});
	});
});

test.afterAll(async () => {
	await new Promise(resolvePromise => {
		server.close(resolvePromise);
	});
});

/*
Wait for the wiki inside the iframe to have booted, then return its frame
*/
async function getWikiFrame(page) {
	let wikiFrame;
	await expect.poll(() => {
		wikiFrame = page.frames().find(f => f.url().includes("test.html"));
		return !!wikiFrame;
	}, {timeout: 30000}).toBeTruthy();
	await expect(wikiFrame.locator(".tc-site-title")).toHaveText("TiddlyWiki5");
	return wikiFrame;
}

/*
Open the host page and load the embedded wiki, optionally pre-subscribing to
the given subjects. Returns the wiki frame.
*/
async function loadHostedWiki(page,subjects) {
	await page.goto(baseUrl + "/host.html");
	await page.evaluate(({wikiUrl,subjects: s}) => window.loadWiki(wikiUrl,s),
		{wikiUrl: baseUrl + "/test.html",subjects});
	return await getWikiFrame(page);
}

/*
Trigger a save from inside the wiki and capture any alert dialog
*/
async function saveWiki(frame) {
	return await frame.evaluate(() => new Promise(resolve => {
		var dialogResult;
		window.alert = function(message) {
			dialogResult = {error: message};
		};
		$tw.rootWidget.dispatchEvent({type: "tm-save-wiki"});
		// Let microtasks, port messages and timers settle
		setTimeout(function() {
			resolve(dialogResult || {ok: true});
		},1500);
	}));
}

test("host subscriber receives SAVE with full HTML and OK confirms the save", async ({ page }) => {
	const frame = await loadHostedWiki(page,[]);
	// Host opens the SAVE subscription with OK replies
	await page.evaluate(() => window.subscribe("SAVE","ok"));
	await expect.poll(() => frame.evaluate(() => $tw.saverHandler.savers.some(s => s.info.name === "postmessage" && s.info.capabilities.includes("save"))),
		{timeout: 5000}).toBeTruthy();
	const result = await saveWiki(frame);
	expect(result.ok, "save should succeed without an alert").toBeTruthy();
	// The host received exactly the full wiki HTML
	const messages = await page.evaluate(() => window.hostState.saveMessages);
	expect(messages).toHaveLength(1);
	expect(messages[0].verb).toBe("SAVE");
	expect(messages[0].body).toMatch(/^\s*<!doctype html>/i);
	expect(messages[0].body).toContain("TiddlyWiki");
	// The wiki shows the "Saved wiki" notification
	await expect(frame.locator(".tc-notification", {hasText: "Saved wiki"}).first()).toBeVisible();
});

test("host replying with anything other than OK shows a save error", async ({ page }) => {
	const frame = await loadHostedWiki(page,[]);
	page.on("dialog", dialog => dialog.dismiss());
	await page.evaluate(() => window.subscribe("SAVE","error"));
	const result = await saveWiki(frame);
	expect(result.error).toContain("host says no");
});

test("host that never replies eventually reports a timeout error", async ({ page }) => {
	test.setTimeout(30000);
	const frame = await loadHostedWiki(page,[]);
	await page.evaluate(() => window.subscribe("SAVE","timeout"));
	const result = await frame.evaluate(() => new Promise(resolve => {
		var dialogResult;
		window.alert = function(message) {
			dialogResult = {error: message};
		};
		var started = Date.now();
		$tw.rootWidget.dispatchEvent({type: "tm-save-wiki"});
		var timer = setInterval(function() {
			if(dialogResult) {
				clearInterval(timer);
				resolve({error: dialogResult.error,elapsed: Date.now() - started});
			}
		},200);
	}));
	expect(result.error).toContain("Timeout");
	// Timeout is 10s; allow some scheduling slack but require it was awaited
	expect(result.elapsed).toBeGreaterThanOrEqual(9000);
});

test("without a SAVE subscriber saving falls back to the download saver", async ({ page }) => {
	const frame = await loadHostedWiki(page,[]);
	// No subscription: the postmessage saver advertises no capabilities
	const capabilities = await frame.evaluate(() => {
		var saver = $tw.saverHandler.savers.find(s => s.info.name === "postmessage");
		return saver ? saver.info.capabilities : "saver-missing";
	});
	expect(capabilities).toEqual([]);
	// Saving triggers the download saver instead
	const[download] = await Promise.all([
		page.waitForEvent("download"),
		frame.evaluate(() => $tw.rootWidget.dispatchEvent({type: "tm-save-wiki"}))
	]);
	expect(download.suggestedFilename()).toMatch(/\.html$/);
	// The downloaded stream is the wiki HTML
	const downloadBody = await new Promise((resolvePromise,rejectPromise) => {
		var chunks = [];
		download.createReadStream().then(stream => {
			stream.on("data",chunk => chunks.push(chunk));
			stream.on("end",() => resolvePromise(Buffer.concat(chunks).toString()));
			stream.on("error",rejectPromise);
		});
	});
	expect(downloadBody).toMatch(/^\s*<!doctype html>/i);
});

test("after UNSUBSCRIBE the host stops receiving and saving falls back", async ({ page }) => {
	const frame = await loadHostedWiki(page,["SAVE"]);
	await expect.poll(() => page.evaluate(() => window.hostState.saveMessages.length)).toBe(0);
	const result1 = await saveWiki(frame);
	expect(result1.ok).toBeTruthy();
	expect(await page.evaluate(() => window.hostState.saveMessages.length)).toBe(1);
	// Host closes the subscription
	await page.evaluate(() => window.unsubscribe("SAVE"));
	await expect.poll(() => frame.evaluate(() => {
		var saver = $tw.saverHandler.savers.find(s => s.info.name === "postmessage");
		return saver.info.capabilities.length;
	}),{timeout: 5000}).toBe(0);
	// A further save is handled by the next saver (a download)
	const[download] = await Promise.all([
		page.waitForEvent("download"),
		frame.evaluate(() => $tw.rootWidget.dispatchEvent({type: "tm-save-wiki"}))
	]);
	expect(download.suggestedFilename()).toMatch(/\.html$/);
	expect(await page.evaluate(() => window.hostState.saveMessages.length)).toBe(1);
});

test("subscribed host immediately receives the current page title and live updates", async ({ page }) => {
	const frame = await loadHostedWiki(page,["PAGETITLE"]);
	// Immediate replay of the current value (site title plus subtitle)
	await expect(page.locator("#pageTitle")).toContainText("TiddlyWiki5");
	// Change the title tiddler: the host receives the update live
	await frame.evaluate(() => {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/SiteTitle", text: "Renamed Wiki"}));
	});
	await expect(page.locator("#pageTitle")).toContainText("Renamed Wiki");
});

test("subscribed host immediately receives the current favicon and live updates", async ({ page }) => {
	const frame = await loadHostedWiki(page,["FAVICON"]);
	// The test wiki ships an SVG favicon tiddler
	await expect.poll(async () => {
		const src = await page.locator("#faviconImg").getAttribute("src");
		return src ? src.startsWith("data:image/svg") : false;
	}, {timeout: 5000}).toBeTruthy();
	// Replace the favicon: the host is republished the new data URI
	await frame.evaluate(() => {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/favicon.ico", type: "text/plain", text: "NEWFAVICON"}));
	});
	await expect.poll(async () => {
		const src = await page.locator("#faviconImg").getAttribute("src");
		return src && src.includes("NEWFAVICON") ? src : null;
	}, {timeout: 5000}).toBeTruthy();
});

test("unrelated window traffic does not disturb the subscription protocol", async ({ page }) => {
	const frame = await loadHostedWiki(page,["SAVE"]);
	await page.evaluate(() => window.postUnrelatedMessage());
	const result = await saveWiki(frame);
	expect(result.ok).toBeTruthy();
	expect(await page.evaluate(() => window.hostState.saveMessages.length)).toBe(1);
	// An unknown subject is ignored: it neither creates a subscriber nor breaks saving
	await frame.evaluate(() => window.postMessage({verb: "SUBSCRIBE", to: "NOT-A-SUBJECT"},"*"));
	// A SUBSCRIBE for a known subject without a port is ignored too
	await frame.evaluate(() => window.postMessage({verb: "SUBSCRIBE", to: "FAVICON"},"*"));
	await page.evaluate(() => window.postUnrelatedMessage());
	const result2 = await saveWiki(frame);
	expect(result2.ok).toBeTruthy();
	expect(await page.evaluate(() => window.hostState.saveMessages.length)).toBe(2);
});

test("autosave with a subscriber is delivered over the SAVE port", async ({ page }) => {
	const frame = await loadHostedWiki(page,["SAVE"]);
	// Make the wiki dirty with a normal tiddler change
	await frame.evaluate(() => {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "DirtyTiddler", text: "unsaved content"}));
	});
	await expect.poll(() => frame.evaluate(() => $tw.saverHandler.isDirty())).toBeTruthy();
	const result = await frame.evaluate(() => new Promise(resolve => {
		window.alert = function(message) {
			resolve({error: message});
		};
		$tw.rootWidget.dispatchEvent({type: "tm-auto-save-wiki"});
		setTimeout(() => resolve({ok: true}),1500);
	}));
	expect(result.ok).toBeTruthy();
	const messages = await page.evaluate(() => window.hostState.saveMessages);
	expect(messages).toHaveLength(1);
	expect(messages[0].verb).toBe("SAVE");
	expect(messages[0].body).toContain("DirtyTiddler");
	// Acknowledged autosave clears the dirty state
	await expect.poll(() => frame.evaluate(() => $tw.saverHandler.isDirty())).toBeFalsy();
});

test("jasmine unit tests still pass", async ({ page }) => {
	await page.goto(baseUrl + "/test.html");
	const timeout = 1000 * 30;
	await expect(page.locator(".tc-site-title")).toHaveText("TiddlyWiki5");
	await expect(page.locator(".jasmine-overall-result")).toBeVisible({timeout});
	await expect(page.locator(".jasmine-overall-result.jasmine-failed")).not.toBeVisible();
	await expect(page.locator(".jasmine-overall-result.jasmine-passed")).toBeVisible();
});
