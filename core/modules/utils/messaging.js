/*\
title: $:/core/modules/utils/messaging.js
type: application/javascript
module-type: utils

Messaging support for hosting TiddlyWiki in an iframe within a host page.

The host page subscribes to topics by posting a message like
{verb:"SUBSCRIBE",to:"SAVE"} to the iframe window, with a MessagePort
transferred in event.ports[0]. Subsequent events for the topic are
delivered over that port. The host can unsubscribe at any time by posting
{verb:"UNSUBSCRIBE",to:<topic>} over the same port.

\*/

"use strict";

var SUPPORTED_TOPICS = ["SAVE","PAGETITLE","FAVICON"];

/*
Manages subscriptions from host pages to topics such as "SAVE",
"PAGETITLE" and "FAVICON". A single instance is created lazily via
$tw.utils.Messaging.getInstance() so that all callers share its state
*/
var Messaging = function() {
	var self = this;
	// Map of topic -> array of subscribed ports
	this.portsByTopic = Object.create(null);
	// Map of port -> queue of handlers awaiting the next request reply
	this.replyHandlers = new WeakMap();
	// Map of topic -> optional provider function returning the current
	// value, replayed immediately when a new subscription arrives
	this.providersByTopic = Object.create(null);
	$tw.utils.each(SUPPORTED_TOPICS,function(topic) {
		self.portsByTopic[topic] = [];
	});
	if($tw.browser) {
		window.addEventListener("message",function(event) {
			self.handleWindowMessage(event);
		},false);
	}
};

/*
Return true if at least one port is subscribed to the given topic
*/
Messaging.prototype.hasSubscribers = function(topic) {
	var ports = this.portsByTopic[topic];
	return !!ports && ports.length > 0;
};

/*
Handle a SUBSCRIBE message posted to our window. New subscriptions
carry a MessagePort in event.ports[0]
*/
Messaging.prototype.handleWindowMessage = function(event) {
	var data = event.data || {};
	if(data.verb === "SUBSCRIBE" && event.ports && event.ports[0]) {
		this.subscribe(data.to,event.ports[0]);
	}
};

/*
Subscribe a port to a topic. If a provider is registered for the topic
its current value is published immediately so that the subscriber does
not miss the present state
*/
Messaging.prototype.subscribe = function(topic,port) {
	var ports = this.portsByTopic[topic];
	if(!ports || ports.indexOf(port) !== -1) {
		return;
	}
	var self = this;
	ports.push(port);
	// A single onmessage handler is shared because MessagePort only
	// dispatches to onmessage or to "message" listeners, not both (notably
	// in Firefox)
	port.onmessage = function(messageEvent) {
		self.handlePortMessage(port,messageEvent);
	};
	if(this.providersByTopic[topic]) {
		this.publish(topic,this.providersByTopic[topic]());
	}
};

/*
Remove a port from every topic it is subscribed to
*/
Messaging.prototype.removePort = function(port) {
	$tw.utils.each(this.portsByTopic,function(ports) {
		var index = ports.indexOf(port);
		if(index !== -1) {
			ports.splice(index,1);
		}
	});
};

/*
Handle a message received on a subscribed port. Messages are either
host control messages (at present only UNSUBSCRIBE) or replies to a
request made via Messaging.prototype.request
*/
Messaging.prototype.handlePortMessage = function(port,event) {
	var data = event.data || {};
	// A pending request reply always gets first refusal of the message
	var queue = this.replyHandlers.get(port);
	var replyHandler = queue && queue[0];
	if(replyHandler && replyHandler(data)) {
		return;
	}
	var ports = this.portsByTopic[data.to];
	if(data.verb === "UNSUBSCRIBE" && ports) {
		var index = ports.indexOf(port);
		if(index !== -1) {
			ports.splice(index,1);
		}
	}
};

/*
Register a function returning the current value of a topic. It is
invoked for each new subscription so the present value can be replayed
*/
Messaging.prototype.registerProvider = function(topic,provider) {
	this.providersByTopic[topic] = provider;
};

/*
Send a message for a topic to every subscribed port, dropping ports
that can no longer be reached
*/
Messaging.prototype.publish = function(topic,message) {
	var ports = this.portsByTopic[topic] ? this.portsByTopic[topic].slice(0) : [];
	for(var t=0; t<ports.length; t++) {
		try {
			ports[t].postMessage(message);
		} catch(ex) {
			this.removePort(ports[t]);
		}
	}
};

/*
Send a request over every port subscribed to a topic and collect the
replies. onReply(err,data) is invoked once per replying port. If a
timeout is given, onReply is called with a timeout error for any port
that has not replied when it elapses. Returns the number of ports that
were contacted
*/
Messaging.prototype.request = function(topic,message,onReply,timeout) {
	var ports = this.portsByTopic[topic] ? this.portsByTopic[topic].slice(0) : [],
		self = this;
	for(var t=0; t<ports.length; t++) {
		(function(port) {
			var settled = false,
				timerId = null,
				queue = self.replyHandlers.get(port) || [];
			if(!self.replyHandlers.has(port)) {
				self.replyHandlers.set(port,queue);
			}
			function complete(err,data) {
				if(settled) {
					return;
				}
				settled = true;
				if(timerId !== null) {
					clearTimeout(timerId);
				}
				var index = queue.indexOf(handleReply);
				if(index !== -1) {
					queue.splice(index,1);
				}
				onReply(err,data);
			}
			// Returning true marks the message as consumed by this request.
			// The only port message that is not a reply is UNSUBSCRIBE
			function handleReply(data) {
				if(data.verb === "UNSUBSCRIBE") {
					return false;
				}
				if(data.verb === "OK") {
					complete(null,data);
				} else {
					complete((data.verb || "ERROR") + (data.reason ? ": " + data.reason : ""),data);
				}
				return true;
			}
			queue.push(handleReply);
			if(timeout) {
				timerId = setTimeout(function() {
					complete("Timeout waiting for host response");
				},timeout);
			}
			try {
				port.postMessage(message);
			} catch(ex) {
				complete(ex.message || ex);
			}
		})(ports[t]);
	}
	return ports.length;
};

/*
Lazily create the singleton instance
*/
Messaging.getInstance = function() {
	if(!Messaging.instance) {
		Messaging.instance = new Messaging();
	}
	return Messaging.instance;
};

exports.Messaging = Messaging;
