/*\
title: $:/core/modules/savers/postmessage.js
type: application/javascript
module-type: saver

Saves wiki HTML by sending it to a host page over a MessagePort.

The host page embeds the TiddlyWiki in an iframe and opens a MessageChannel,
passing one of its ports in a window message:

	iframe.contentWindow.postMessage({verb:"SUBSCRIBE", to:"SAVE"}, "*", [channel.port2])

On save the wiki posts {verb:"SAVE", body:<full HTML>} to the host on the port.
The host replies with {verb:"OK"} to confirm success; any other verb reports an
error. Until a host subscribes (or once it unsubscribes), this saver reports no
capabilities and saving falls through to the other savers.

\*/

"use strict";

/*
Time to wait for the host's confirmation before reporting a save error
*/
var SAVE_ACKNOWLEDGEMENT_TIMEOUT = 10000;

var PostMessageSaver = function(wiki) {
	this.wiki = wiki;
	// The save currently awaiting acknowledgement, if any: {callback, timer}
	this.pendingSave = null;
	var self = this;
	var hub = $tw.utils.getMessageHub();
	if(hub) {
		hub.addListener("SAVE",function(event) {
			if(event.type === "unsubscribe") {
				// A save in flight can no longer be acknowledged
				self.failPendingSave("Host closed the save connection");
			} else if(event.type === "message") {
				self.handleHostMessage(event.data);
			}
		});
	}
};

/*
Process an acknowledgement message from the host
*/
PostMessageSaver.prototype.handleHostMessage = function(data) {
	if(!this.pendingSave || !data || typeof data !== "object") {
		return;
	}
	if(data.verb === "OK") {
		this.succeedPendingSave();
	} else if(data.verb === "ERROR") {
		this.failPendingSave(data.message || "Host reported a save error");
	} else {
		// Anything other than OK is treated as a failure
		this.failPendingSave("Host returned an unrecognised response: " + (data.verb || ""));
	}
};

/*
Clear the timer and state of the save awaiting acknowledgement
*/
PostMessageSaver.prototype.clearPendingSave = function() {
	if(this.pendingSave) {
		if(this.pendingSave.timer) {
			clearTimeout(this.pendingSave.timer);
		}
		this.pendingSave = null;
	}
};

PostMessageSaver.prototype.succeedPendingSave = function() {
	var pendingSave = this.pendingSave;
	if(!pendingSave) {
		return;
	}
	this.clearPendingSave();
	pendingSave.callback(null);
};

PostMessageSaver.prototype.failPendingSave = function(error) {
	var pendingSave = this.pendingSave;
	if(!pendingSave) {
		return;
	}
	this.clearPendingSave();
	pendingSave.callback(error);
};

PostMessageSaver.prototype.save = function(text,method,callback) {
	var hub = $tw.utils.getMessageHub();
	// Only take over saving while a host is subscribed; otherwise let the
	// saver handler try the remaining savers
	if(!hub || !hub.hasSubscriber("SAVE")) {
		return false;
	}
	// One save at a time: fail the previous acknowledgement rather than
	// resolving two saves with one host response
	this.failPendingSave("Superseded by a newer save request");
	var self = this;
	var delivered = hub.post("SAVE",{
		verb: "SAVE",
		body: text
	});
	if(!delivered) {
		return false;
	}
	this.pendingSave = {
		callback: callback,
		timer: setTimeout(function() {
			self.failPendingSave("Timeout waiting for the host to confirm the save");
		},SAVE_ACKNOWLEDGEMENT_TIMEOUT)
	};
	return true;
};

/*
Information about this saver
*/
PostMessageSaver.prototype.info = {
	name: "postmessage",
	priority: 3000
};

/*
The capabilities are dynamic: the save/autosave methods are only offered while
a host page holds an active SAVE subscription, so that saving otherwise falls
back to the other savers.
*/
Object.defineProperty(PostMessageSaver.prototype.info,"capabilities",{
	get: function() {
		var capabilities = [];
		var hub = $tw.utils.getMessageHub();
		if(hub && hub.hasSubscriber("SAVE")) {
			capabilities = ["save","autosave"];
		}
		return capabilities;
	}
});

/*
Static method that returns true if this saver is capable of working in this
environment
*/
exports.canSave = function(wiki) {
	return typeof window !== "undefined" && typeof window.postMessage === "function" && typeof MessageChannel === "function";
};

/*
Create an instance of this saver
*/
exports.create = function(wiki) {
	return new PostMessageSaver(wiki);
};
