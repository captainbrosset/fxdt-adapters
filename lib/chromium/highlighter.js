const {emit} = require("../devtools/event"); // Needs to share a loader with protocol.js, boo.
const task = require("../util/task");

const protocol = require("../devtools/server/protocol");
const {asyncMethod} = require("../util/protocol-extra");
const {Actor, ActorClass, Pool, method, Arg, Option, RetVal, types} = protocol;

const timers = require("sdk/timers");
const HIGHLIGHTER_PICKED_TIMER = 1000;
const HIGHLIGHTER_CONFIG = {
  showInfo: true,
  contentColor: { r: 0x80, g: 0xd4, b: 0xff, a: 0.4 },
  paddingColor: { r: 0x66, g: 0xcc, b: 0x52, a: 0.4 },
  borderColor: { r: 0xff, g: 0xe4, b: 0x31, a: 0.4 },
  marginColor: { r: 0xd8, g: 0x9b, b: 0x28, a: 0.4 },
  eventTargetColor: { r: 0, g: 0, b: 255 }
};
// All possible highlighter classes
let HIGHLIGHTER_CLASSES = exports.HIGHLIGHTER_CLASSES = {
  "SelectorHighlighter": SelectorHighlighter
};

var ChromiumHighlighterActor = protocol.ActorClass({
  typeName: "chromium_highlighter",

  initialize(inspector, autohide) {
    Actor.prototype.initialize.call(this, null);
    this.inspector = inspector;
  },

  get conn() { return this.inspector.conn },
  get rpc() { return this.inspector.rpc },

  showBoxModel: asyncMethod(function*(node, options={}) {
    let response = yield this.rpc.request("DOM.highlightNode", {
      nodeId: node.handle.nodeId,
      highlightConfig: HIGHLIGHTER_CONFIG,
    });
  }, {
    request: {
      node: Arg(0, "chromium_domnode"),
      region: Option(1)
    }
  }),

  hideBoxModel: asyncMethod(function*() {
    yield this.rpc.request("DOM.hideHighlight");
  }),

  pick: asyncMethod(function*() {
    yield this.rpc.request("DOM.setInspectModeEnabled", {
      enabled: true,
      highlightConfig: HIGHLIGHTER_CONFIG
    });

    // XXX: the protocol doesn't send notifications when nodes are being hovered
    // when the inspect mode is enabled, so "picker-node-hovered" cannot be sent
    // which means the markup-view won't live-update as the mouse moves.

    this.inspector.walker.on("picker-node-picked", task.async(function*(args) {
      yield this.rpc.request("DOM.setInspectModeEnabled", {
        enabled: false
      });
      timers.setTimeout(function() {}, HIGHLIGHTER_PICKED_TIMER);
    }));
  }),

  cancelPick: method(function() {
    yield this.rpc.request("DOM.setInspectModeEnabled", {
      enabled: false
    });
  }),
});
exports.ChromiumHighlighterActor = ChromiumHighlighterActor;

var ChrominumCustomHighlighterActor = protocol.ActorClass({
  typeName: "chromium_customhighlighter",

  initialize(inspector, typeName) {
    protocol.Actor.prototype.initialize.call(this, null);
    this.inspector = inspector;

    let constructor = HIGHLIGHTER_CLASSES[typeName];
    if (!constructor) {
      throw new Error(typeName + " isn't a valid highlighter class (" +
        Object.keys(HIGHLIGHTER_CLASSES) + ")");
      return;
    }

    this._highlighter = new constructor(this.rpc);
  },

  get conn() { return this.inspector.conn },
  get rpc() { return this.inspector.rpc },

  destroy: function() {
    protocol.Actor.prototype.destroy.call(this);
    this.finalize();
  },

  /**
   * Display the highlighter on a given NodeActor.
   * @param NodeActor The node to be highlighted
   * @param Object Options for the custom highlighter
   */
  show: asyncMethod(function(node, options) {
    if (!this._highlighter) {
      return;
    }
    yield this._highlighter.show(node, options);
  }, {
    request: {
      node: Arg(0, "chromium_domnode"),
      options: Arg(1, "nullable:json")
    }
  }),

  /**
   * Hide the highlighter if it was shown before
   */
  hide: asyncMethod(function() {
    if (this._highlighter) {
      yield this._highlighter.hide();
    }
  }, {
    request: {}
  }),

  /**
   * Kill this actor. This method is called automatically just before the actor
   * is destroyed.
   */
  finalize: method(function() {
    if (this._highlighter) {
      this._highlighter.destroy();
      this._highlighter = null;
    }
  }, {
    oneway: true
  })
});
exports.ChrominumCustomHighlighterActor = ChrominumCustomHighlighterActor;

// XXX Both Chromium and iOS only support highlighting one element at a time, 
// so this highlighter will not behave as expected. It will instead highlight
// only the first matching node.
function SelectorHighlighter(rpc) {
  this.rpc = rpc;
}

SelectorHighlighter.prototype = {
  show: task.async(function*(node, options) {
    yield this.hide();

    // Get at the parent document to find a base node for querySelectorAll.
    let rootNode = node;
    while (rootNode.parent) {
      rootNode = rootNode.parent;
    }

    let response = yield this.rpc.request("DOM.querySelector", {
      nodeId: rootNode.handle.nodeId,
      selector: options.selector
    });

    yield this.rpc.request("DOM.highlightNode", {
      nodeId: response.nodeId,
      highlightConfig: HIGHLIGHTER_CONFIG,
    });
  }),

  hide: task.async(function*() {
    this.rpc.request("DOM.hideHighlight");
  }),

  destroy() {
    this.hide();
    this.rpc = null;
  }
};
