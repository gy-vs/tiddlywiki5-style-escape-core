const{ test, expect } = require("@playwright/test");
const{resolve} = require("path");

// The single-file wiki is large and takes a while to boot on slower CI machines
test.setTimeout(90000);

const hostPath = resolve(__dirname, "fixtures", "host.html");
const crossPlatformHostPath = hostPath.replace(/^\/+/, "");

function hostUrl(hash = "") {
	return `file:///${crossPlatformHostPath}?wiki=${encodeURIComponent("../output/test.html")}${hash}`;
}

async function waitForHostReady(page) {
	await page.waitForFunction(() => window.__host && window.__host.ready === true, null, {timeout: 60000});
}

async function getWikiFrame(page) {
	await waitForHostReady(page);
	return page.frames().find(f => f.url().split("?")[0].endsWith("/output/test.html"));
}

async function makeWikiDirty(wikiFrame) {
	// Modify a tiddler through the store so the wiki becomes dirty
	await wikiFrame.evaluate(() => {
		$tw.wiki.addTiddler(new $tw.Tiddler({title: "TestSaveTiddler", text: "hello"}));
	});
	await expect(wikiFrame.locator("body")).toHaveClass(/tc-dirty/);
}

async function clickSave(wikiFrame) {
	// Dispatch the same message the save button sends, so we travel the
	// real entry point through the saver handler
	await wikiFrame.evaluate(() => {
		$tw.rootWidget.dispatchEvent({type: "tm-save-wiki", param: undefined, paramObject: {}, widget: $tw.rootWidget});
	});
}

test.describe("postMessage host saver", () => {
	test("save round trip delivers full HTML and marks the wiki saved on OK", async ({ page }) => {
		await page.goto(hostUrl("#topics=save"));
		const wikiFrame = await getWikiFrame(page);

		await makeWikiDirty(wikiFrame);
		await clickSave(wikiFrame);

		// Host must receive a SAVE message carrying the complete wiki HTML
		await page.waitForFunction(() => window.__host.saves.length > 0 && window.__host.saves[window.__host.saves.length - 1].status === "acknowledged", null, {timeout: 10000});
		const saves = await page.evaluate(() => window.__host.saves);
		expect(saves.length).toBe(1);
		expect(saves[0].verb).toBe("SAVE");
		expect(saves[0].body).toContain("<html");
		expect(saves[0].body).toContain("TestSaveTiddler");
		// Saved wiki is a complete single-file TiddlyWiki
		expect(saves[0].body).toContain("tiddlywiki");
		// Wiki clears its dirty state and shows the saved notification
		await expect(wikiFrame.locator("body")).not.toHaveClass(/tc-dirty/);
		await expect(wikiFrame.locator(".tc-notification").filter({hasText: "Saved wiki"})).toBeVisible();
	});

	test("an error reply is surfaced and leaves the wiki dirty", async ({ page }) => {
		await page.goto(hostUrl("#topics=save&reply=error"));
		const wikiFrame = await getWikiFrame(page);

		await makeWikiDirty(wikiFrame);

		// Accept the alert() raised by the error path
		page.on("dialog", dialog => dialog.accept());
		await clickSave(wikiFrame);

		await page.waitForFunction(() => window.__host.saves.length > 0 && window.__host.saves[window.__host.saves.length - 1].status === "rejected", null, {timeout: 10000});
		// Dirty state must survive a failed save so the user can retry
		await expect(wikiFrame.locator("body")).toHaveClass(/tc-dirty/);

		// A subsequent retry must still be a real save (same semantics)
		await clickSave(wikiFrame);
		await page.waitForFunction(() => window.__host.saves.length === 2, null, {timeout: 10000});
		await expect(wikiFrame.locator("body")).toHaveClass(/tc-dirty/);
	});

	test("a host that never replies triggers the client timeout error", async ({ page }) => {
		test.setTimeout(30000);
		await page.goto(hostUrl("#topics=save&reply=none"));
		const wikiFrame = await getWikiFrame(page);

		// Short client-side timeout so the test does not wait 10 seconds
		await wikiFrame.evaluate(() => {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/config/PostMessageSaver/Timeout",
				text: "500"
			}));
		});

		await makeWikiDirty(wikiFrame);
		let resolveDialog;
		const dialogMessage = new Promise(resolve => {
			resolveDialog = resolve;
		});
		page.on("dialog",dialog => {
			resolveDialog(dialog.message());
			dialog.accept();
		});
		await clickSave(wikiFrame);

		const message = await dialogMessage;
		expect(message).toContain("Error while saving");
		expect(message).toContain("Timeout");
		await expect(wikiFrame.locator("body")).toHaveClass(/tc-dirty/);
	});

	test("multiple SAVE subscribers all receive the save and any failure is reported", async ({ page }) => {
		await page.goto(hostUrl("#topics=save&reply=ok"));
		const wikiFrame = await getWikiFrame(page);

		// Second independent subscriber that records what it receives and
		// replies with an error
		await page.evaluate(() => {
			const channel = new MessageChannel();
			window.__secondSave = null;
			channel.port1.onmessage = event => {
				if(event.data && event.data.verb === "SAVE") {
					window.__secondSave = event.data;
					channel.port1.postMessage({verb: "ERROR", reason: "second host failed"});
				}
			};
			document.getElementById("wiki-frame").contentWindow.postMessage({verb: "SUBSCRIBE", to: "SAVE"}, "*", [channel.port2]);
		});
		await page.waitForTimeout(200);

		await makeWikiDirty(wikiFrame);
		let dialogText = "";
		page.on("dialog",dialog => {
			dialogText = dialog.message();
			dialog.accept();
		});
		await clickSave(wikiFrame);

		// Both hosts must receive the same complete document
		await page.waitForFunction(() => window.__host.saves.length === 1 && window.__secondSave !== null, null, {timeout: 10000});
		const saves = await page.evaluate(() => window.__host.saves);
		const secondBody = await page.evaluate(() => window.__secondSave.body);
		expect(saves[0].body).toBe(secondBody);
		expect(saves[0].body).toContain("TestSaveTiddler");
		// Because one host rejected the save, the wiki reports an error and
		// stays dirty despite the other host acknowledging
		await expect.poll(() => dialogText).toContain("second host failed");
		await expect(wikiFrame.locator("body")).toHaveClass(/tc-dirty/);
	});

	test("autosave uses the same SAVE round trip", async ({ page }) => {
		await page.goto(hostUrl("#topics=save"));
		const wikiFrame = await getWikiFrame(page);

		// AutoSave is enabled by default; dispatch the autosave trigger
		await wikiFrame.evaluate(() => {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "AutoSavedTiddler", text: "data"}));
			$tw.rootWidget.dispatchEvent({type: "tm-auto-save-wiki", paramObject: {}, widget: $tw.rootWidget});
		});

		await page.waitForFunction(() => window.__host.saves.length === 1 && window.__host.saves[0].status === "acknowledged", null, {timeout: 10000});
		const saves = await page.evaluate(() => window.__host.saves);
		expect(saves[0].verb).toBe("SAVE");
		expect(saves[0].method).toBe("autosave");
		expect(saves[0].body).toContain("AutoSavedTiddler");
		await expect(wikiFrame.locator("body")).not.toHaveClass(/tc-dirty/);
	});
});

test.describe("PAGETITLE and FAVICON publishing", () => {
	test("subscribers immediately receive the current value and then live updates", async ({ page }) => {
		await page.goto(hostUrl("#topics=pagetitle,favicon"));
		const wikiFrame = await getWikiFrame(page);

		// Immediate replay of the current page title
		await page.waitForFunction(() => window.__host.messages.some(m => m.topic === "PAGETITLE"));
		let messages = await page.evaluate(() => window.__host.messages);
		const firstTitle = messages.find(m => m.topic === "PAGETITLE");
		expect(firstTitle.data.verb).toBe("PAGETITLE");
		expect(firstTitle.data.body).toContain("TiddlyWiki5");

		// Change the site title and expect the new title to be pushed
		await wikiFrame.evaluate(() => {
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "$:/SiteTitle", text: "Renamed Wiki"}));
		});
		await page.waitForFunction(() => {
			const titles = window.__host.messages.filter(m => m.topic === "PAGETITLE").map(m => m.data.body);
			return titles.some(t => t.indexOf("Renamed Wiki") !== -1);
		}, null, {timeout: 10000});
		expect(await wikiFrame.title()).toMatch(/Renamed Wiki/);

		// Favicon is not set in this edition: the current value is null
		await page.waitForFunction(() => window.__host.messages.some(m => m.topic === "FAVICON"));
		messages = await page.evaluate(() => window.__host.messages);
		expect(messages.find(m => m.topic === "FAVICON").data).toEqual({verb: "FAVICON", body: null});

		// Set a favicon tiddler and expect its data URI to be pushed
		await wikiFrame.evaluate(() => {
			$tw.wiki.addTiddler(new $tw.Tiddler({
				title: "$:/favicon.ico",
				type: "image/svg+xml",
				text: "<svg xmlns='http://www.w3.org/2000/svg'></svg>"
			}));
		});
		await page.waitForFunction(() => {
			const icons = window.__host.messages.filter(m => m.topic === "FAVICON").map(m => m.data.body);
			return icons.some(i => typeof i === "string" && i.indexOf("data:image/svg+xml") === 0);
		}, null, {timeout: 10000});
		const faviconHref = await wikiFrame.locator("#faviconLink").getAttribute("href");
		expect(faviconHref).toContain("data:image/svg+xml");
	});

	test("a subscription made after startup still gets the current value", async ({ page }) => {
		// Host does not subscribe initially
		await page.goto(hostUrl("#topics=none"));
		await waitForHostReady(page);
		await page.evaluate(() => window.__host.subscribe("pagetitle"));
		const pushed = await page.waitForFunction(() => {
			const titles = window.__host.messages.filter(m => m.topic === "PAGETITLE");
			return titles.length ? titles[titles.length - 1].data.body : null;
		}, null, {timeout: 10000});
		expect(pushed).toBeTruthy();
	});
});

test.describe("saver fallback", () => {
	test("without a SAVE subscription other savers are used and no SAVE message is posted", async ({ page }) => {
		await page.goto(hostUrl("#topics=pagetitle"));
		const wikiFrame = await getWikiFrame(page);

		await makeWikiDirty(wikiFrame);
		// Prevent an actual download dialog/file from disturbing headless mode
		await wikiFrame.evaluate(() => {
			HTMLAnchorElement.prototype.click = function() {};
		});
		await clickSave(wikiFrame);

		// Give messages a chance to arrive, then assert none are SAVE
		await page.waitForTimeout(500);
		const saves = await page.evaluate(() => window.__host.saves.length);
		expect(saves).toBe(0);
	});

	test("unsubscribing from SAVE hands saving back to other savers", async ({ page }) => {
		await page.goto(hostUrl("#topics=save"));
		const wikiFrame = await getWikiFrame(page);

		// First save while subscribed goes through the port
		await makeWikiDirty(wikiFrame);
		await clickSave(wikiFrame);
		await page.waitForFunction(() => window.__host.saves.length === 1 && window.__host.saves[0].status === "acknowledged", null, {timeout: 10000});
		await expect(wikiFrame.locator("body")).not.toHaveClass(/tc-dirty/);

		// Host unsubscribes
		await page.evaluate(() => window.__host.unsubscribe("save"));
		await page.waitForTimeout(100);

		// Further saves must not reach the port; the download saver takes over
		await wikiFrame.evaluate(() => {
			HTMLAnchorElement.prototype.click = function() {};
			$tw.wiki.addTiddler(new $tw.Tiddler({title: "AfterUnsubscribe", text: "x"}));
		});
		await expect(wikiFrame.locator("body")).toHaveClass(/tc-dirty/);
		await clickSave(wikiFrame);
		await page.waitForTimeout(500);
		const saves = await page.evaluate(() => window.__host.saves.length);
		expect(saves).toBe(1);
	});
});
