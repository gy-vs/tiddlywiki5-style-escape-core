/*\
title: $:/core/modules/startup/favicon.js
type: application/javascript
module-type: startup

Favicon handling

\*/

"use strict";

// Export name and synchronous status
exports.name = "favicon";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

// Favicon tiddler
var FAVICON_TITLE = "$:/favicon.ico";

exports.startup = function() {
	// Set up the favicon
	setFavicon();
	// Publish favicon changes to a subscribed host page
	var hub = $tw.utils.getMessageHub && $tw.utils.getMessageHub();
	// Reset the favicon when the tiddler changes
	$tw.wiki.addEventListener("change",function(changes) {
		if($tw.utils.hop(changes,FAVICON_TITLE)) {
			setFavicon();
			publishFavicon(hub);
		}
	});
	// A host page subscribing immediately receives the current value
	if(hub) {
		hub.addListener("FAVICON",function(event) {
			if(event.type === "subscribe") {
				publishFavicon(hub);
			}
		});
		// Cover a subscription that arrived before this startup module ran
		publishFavicon(hub);
	}
};

/*
Read the current favicon as a data URI, or null when there is none
*/
function getFaviconDataUri() {
	var tiddler = $tw.wiki.getTiddler(FAVICON_TITLE);
	if(!tiddler) {
		return null;
	}
	return $tw.utils.makeDataUri(tiddler.fields.text,tiddler.fields.type,tiddler.fields._canonical_uri);
}

/*
Send the current favicon, as a data URI, to any subscribed host page
*/
function publishFavicon(hub) {
	if(!hub || !hub.hasSubscriber("FAVICON")) {
		return;
	}
	hub.post("FAVICON",{
		verb: "FAVICON",
		body: getFaviconDataUri()
	});
}

function setFavicon() {
	var dataUri = getFaviconDataUri();
	if(dataUri) {
		var faviconLink = document.getElementById("faviconLink");
		faviconLink.setAttribute("href",dataUri);
	}
}
