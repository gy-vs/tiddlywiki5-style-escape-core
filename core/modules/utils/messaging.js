/*\
title: $:/core/modules/utils/messaging.js
type: application/javascript
module-type: utils-browser

Message channel helpers for the postMessage saver and the page title / favicon
pub/sub protocol used by host pages embedding TiddlyWiki in an iframe.

The host page opens the protocol by sending a window message of the form:

	{verb: "SUBSCRIBE", to: "SAVE"}        // plus a MessagePort in event.ports[0]
	{verb: "SUBSCRIBE", to: "PAGETITLE"}   // plus a MessagePort in event.ports[0]
	{verb: "SUBSCRIBE", to: "FAVICON"}     // plus a MessagePort in event.ports[0]

and can end it with:

	{verb: "UNSUBSCRIBE", to: "SAVE"}

Each subject has at most one subscriber: the port carried by the most recent
SUBSCRIBE message replaces (and closes) any previous port. Messages with
unexpected verbs or for unknown subjects are ignored so that unrelated window
traffic, such as the plugin library GET / GET-RESPONSE traffic handled by
browser-messaging, is left untouched.

Wiki modules interact with the protocol through the lazily created singleton
returned by $tw.utils.getMessageHub():

	hub.addListener("SAVE",function(event) {
		// event.type is "subscribe", "unsubscribe" or "message"
	});
	hub.post("SAVE",{verb: "SAVE", body: text}); // returns false when nobody is subscribed
	hub.hasSubscriber("PAGETITLE");

\*/

"use strict";

/*
The subjects that host pages may subscribe to
*/
var MESSAGING_SUBJECTS = ["SAVE","PAGETITLE","FAVICON"];

/*
Return the process-wide message hub, creating it on first use in a browser
*/
exports.getMessageHub = function() {
	if($tw.messageHub) {
		return $tw.messageHub;
	}
	if(!$tw.browser || typeof window === "undefined" || typeof window.addEventListener !== "function") {
		return null;
	}
	// Current subscriber port per subject, or null
	var ports = Object.create(null);
	// Consumer listeners per subject
	var listeners = Object.create(null);
	$tw.utils.each(MESSAGING_SUBJECTS,function(subject) {
		ports[subject] = null;
		listeners[subject] = [];
	});
	/*
	Notify every consumer of a subject; a failing consumer must not disturb
	the others or the hub itself
	*/
	function emit(subject,event) {
		$tw.utils.each(listeners[subject],function(listener) {
			try {
				listener(event);
			} catch(ex) {
			}
		});
	}
	/*
	Forget the current port for a subject, closing it and telling consumers
	*/
	function clearSubscription(subject) {
		var port = ports[subject];
		if(port) {
			try {
				port.close();
			} catch(ex) {
			}
			ports[subject] = null;
			emit(subject,{type: "unsubscribe", subject: subject});
		}
	}
	/*
	Install a new subscriber port for a subject
	*/
	function setSubscription(subject,port) {
		// Drop any previous subscriber first so consumers see a clean transition
		clearSubscription(subject);
		ports[subject] = port;
		// Route messages arriving on the port to consumers of this subject
		port.onmessage = function(event) {
			emit(subject,{type: "message", subject: subject, data: event.data, port: port});
		};
		emit(subject,{type: "subscribe", subject: subject, port: port});
	}
	/*
	Handle SUBSCRIBE / UNSUBSCRIBE window messages; ignores everything else
	*/
	function handleWindowMessage(event) {
		var data = event && event.data;
		if(!data || typeof data !== "object") {
			return;
		}
		if(!$tw.utils.hop(ports,data.to)) {
			return;
		}
		if(data.verb === "SUBSCRIBE") {
			var port = event.ports && event.ports[0];
			if(!port) {
				return;
			}
			setSubscription(data.to,port);
		} else if(data.verb === "UNSUBSCRIBE") {
			clearSubscription(data.to);
		}
	}
	window.addEventListener("message",handleWindowMessage,false);
	$tw.messageHub = {
		/*
		Register a consumer for lifecycle/message events on a subject.
		Returns a function that removes the listener.
		*/
		addListener: function(subject,listener) {
			if(!$tw.utils.hop(listeners,subject)) {
				return function() {};
			}
			listeners[subject].push(listener);
			return function() {
				var index = listeners[subject].indexOf(listener);
				if(index !== -1) {
					listeners[subject].splice(index,1);
				}
			};
		},
		/*
		Post a message on the current subscriber port. Returns false when
		there is no subscriber or the port is dead, in which case the stale
		subscription is discarded so callers can fall back to other behaviour.
		*/
		post: function(subject,message) {
			var port = ports[subject];
			if(!port) {
				return false;
			}
			try {
				port.postMessage(message);
			} catch(ex) {
				clearSubscription(subject);
				return false;
			}
			return true;
		},
		/*
		Check whether a subject currently has a live subscriber
		*/
		hasSubscriber: function(subject) {
			return !!ports[subject];
		},
		/*
		Close every port and forget every subscriber
		*/
		shutdown: function() {
			$tw.utils.each(MESSAGING_SUBJECTS,function(subject) {
				clearSubscription(subject);
			});
		}
	};
	return $tw.messageHub;
};
