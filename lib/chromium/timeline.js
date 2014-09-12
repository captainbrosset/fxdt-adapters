const {emit} = require("../devtools/event"); // Needs to share a loader with protocol.js, boo.
const task = require("../util/task");

const protocol = require("../devtools/server/protocol");
const {asyncMethod} = require("../util/protocol-extra");
const {Actor, ActorClass, Pool, method, Arg, Option, RetVal, types} = protocol;
const {setTimeout, clearTimeout} = require("sdk/timers");

const TIMELINE_EVENT_BATCHES_RATE = 200; // ms

var ChromiumTimelineActor = ActorClass({
  typeName: "chromium_timeline",

  events: {
    /**
     * "markers" events are emitted at regular intervals when profile markers
     * are found. A marker has the following properties:
     * - start {Number}
     * - end {Number}
     * - name {String}
     */
    "markers" : {
      type: "markers",
      markers: Arg(0, "array:json")
    }
  },

  initialize: function(tab) {
    Actor.prototype.initialize.call(this, tab.conn);
    this.tab = tab;
    this.rpc = tab.rpc;

    this.rpc.on("Timeline.eventRecorded", this.onEventRecorded.bind(this));

    this._isRecording = false;
  },

  isRecording: method(function() {
    return this._isRecording;
  }, {
    request: {},
    response: {
      value: RetVal("boolean")
    }
  }),

  start: asyncMethod(function() {
    if (this._isRecording) {
      return;
    }

    this._isRecording = true;
    this._recorded = [];
    this._sendEventBatch();

    yield this.rpc.request("Timeline.start", {});
  }, {
    request: {},
    response: {}
  }),

  stop: asyncMethod(function() {
    if (!this._isRecording) {
      return;
    }

    clearTimeout(this._eventBatchesTimeout);
    this._isRecording = false;
    this._recorded = [];
    this._startTime = null;

    yield this.rpc.request("Timeline.stop", {});
  }, {
    request: {},
    response: {}
  }),

  _sendEventBatch: function() {
    if (this._recorded.length > 0) {
      emit(this, "markers", this._recorded);
      this._recorded = [];
    }

    this._eventBatchesTimeout = setTimeout(() => this._sendEventBatch(),
                                           TIMELINE_EVENT_BATCHES_RATE);
  },

  onEventRecorded: function({record}) {
    // Set the start time offset if this is the first event, so that all markers
    // have their time offset by this amount
    if (!this._startTime) {
      this._startTime = parseInt(record.startTime);
    }
    if (this["_handle" + record.type + "Event"]) {
      this["_handle" + record.type + "Event"](record);
    }
  },

  _getOffsetTime: function(time) {
    return parseInt(time) - this._startTime;
  },

  _handleRasterizeEvent: function(record) {
    this._recorded.push({
      name: "Paint",
      start: this._getOffsetTime(record.startTime),
      end: this._getOffsetTime(record.endTime)
    });
  },

  _handleProgramEvent: function(record) {
    for (let {type, startTime, endTime} of record.children) {
      if (type === "UpdateLayerTree") {
        this._recorded.push({
          name: "Paint",
          start: this._getOffsetTime(startTime),
          end: this._getOffsetTime(endTime)
        });
      } else if (type === "RecalculateStyles") {
        this._recorded.push({
          name: "Styles",
          start: this._getOffsetTime(startTime),
          end: this._getOffsetTime(endTime)
        });
      }
    }
  }
});

exports.ChromiumTimelineActor = ChromiumTimelineActor;
