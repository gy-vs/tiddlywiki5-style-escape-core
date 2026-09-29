/*\
title: $:/core/modules/savers/postmessage.js
type: application/javascript
module-type: saver

Handles saving when TiddlyWiki is hosted in an iframe and the host page
has subscribed to saving via window.postMessage with a MessagePort.

If no host page has subscribed to the "SAVE" topic then this saver
reports that it cannot handle the save, allowing lower priority savers
(such as the download saver) to take over.

\*/

"use strict";

/*
Set up the saver
*/
var PostMessageSaver = function(wiki) {
	this.wiki = wiki;
};

PostMessageSaver.prototype.save = function(text,method,callback) {
	var messaging = $tw.utils.Messaging.getInstance();
	// If nobody has subscribed to saving then defer to other savers
	if(!messaging.hasSubscribers("SAVE")) {
		return false;
	}
	var timeout = parseInt(this.wiki.getTiddlerText("$:/config/PostMessageSaver/Timeout","10000"),10);
	if(isNaN(timeout)) {
		timeout = 10000;
	}
	var repliesPending = 0,
		firstError = null;
	repliesPending = messaging.request("SAVE",{
		verb: "SAVE",
		method: method,
		body: text
	},function(err) {
		if(err && !firstError) {
			firstError = err;
		}
		// Only call the saver handler callback once, when the last
		// subscribed host has replied
		repliesPending -= 1;
		if(repliesPending === 0) {
			callback(firstError);
		}
	},timeout);
	if(repliesPending === 0) {
		// The subscription was removed between our check and the request
		return false;
	}
	return true;
};

/*
Information about this saver
*/
PostMessageSaver.prototype.info = {
	name: "postmessage",
	priority: 3000,
	capabilities: ["save","autosave"]
};

/*
Static method that returns true if this saver is capable of working in
the current environment
*/
exports.canSave = function(wiki) {
	return !!($tw.browser && typeof window !== "undefined" && typeof MessageChannel !== "undefined");
};

/*
Create an instance of this saver
*/
exports.create = function(wiki) {
	return new PostMessageSaver(wiki);
};
