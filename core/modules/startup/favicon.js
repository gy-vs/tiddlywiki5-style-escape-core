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
	// Set up publishing of the favicon to any host page that has subscribed
	var messaging = $tw.utils.Messaging.getInstance();
	messaging.registerProvider("FAVICON",function() {
		return {verb: "FAVICON", body: getFaviconDataUri()};
	});
	// Set up the favicon
	setFavicon();
	// Publish the current value so a subscription that arrived before this
	// startup module also receives the present favicon
	messaging.publish("FAVICON",{verb: "FAVICON", body: getFaviconDataUri()});
	// Reset the favicon when the tiddler changes
	$tw.wiki.addEventListener("change",function(changes) {
		if($tw.utils.hop(changes,FAVICON_TITLE)) {
			setFavicon();
			messaging.publish("FAVICON",{verb: "FAVICON", body: getFaviconDataUri()});
		}
	});
};

function getFaviconDataUri() {
	var tiddler = $tw.wiki.getTiddler(FAVICON_TITLE);
	if(tiddler) {
		return $tw.utils.makeDataUri(tiddler.fields.text,tiddler.fields.type,tiddler.fields._canonical_uri);
	}
	return null;
}

function setFavicon() {
	var tiddler = $tw.wiki.getTiddler(FAVICON_TITLE);
	if(tiddler) {
		var faviconLink = document.getElementById("faviconLink");
		faviconLink.setAttribute("href",getFaviconDataUri());
	}
}
