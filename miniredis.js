// exported symbol
Miniredis = {};

var throwNotImplementedError = function (cb) {
  var err =
    new Error("The called method is not available in miniredis implementation");
  callInCallbackOrThrow(err, cb);
};

var throwIncorrectKindOfValueError = function (cb) {
  // XXX should be a special type of error "WRONGTYPE"
  var err =
    new Error("Operation against a key holding the wrong kind of value");
  callInCallbackOrThrow(err, cb);
};

// An abstract represtation of a set of keys matching PATTERN
Miniredis.Cursor = function (redisStore, pattern) {
  var self = this;
  self.redisStore = redisStore;
  self.pattern = pattern;
};

// returns the position where x should be inserted in a sorted array
var insPos = function (arr, x) {
  var l = 0, r = arr.length - 1;
  while (l <= r) {
    var m = (l + r) >> 1;
    if (arr[m] <= x)
      l = m + 1;
    else
      r = m - 1;
  }

  return l;
};

// returns added/changed/removed callbacks which call the passed ordered
// callbacks addedAt/changedAt/removedAt/movedTo
var translateToOrderedCallbacks = function (orderedCallbacks) {
  var queryResult = [];
  return {
    added: function (doc) {
      var pos = insPos(queryResult, doc._id);
      var before = pos === queryResult.length ? null : queryResult[pos];
      queryResult.splice(pos, 0, doc._id);
      orderedCallbacks.addedAt && orderedCallbacks.addedAt(doc, pos, before);
    },
    changed: function (newDoc, oldDoc) {
      var pos = insPos(queryResult, newDoc._id) - 1;
      orderedCallbacks.changedAt && orderedCallbacks.changedAt(newDoc, oldDoc, pos);
    },
    removed: function (doc) {
      var pos = insPos(queryResult, doc._id) - 1;
      queryResult.splice(pos, 1);
      orderedCallbacks.removedAt && orderedCallbacks.removedAt(doc, pos);
    }
  };
};

// returns added/changed/removed/addedAt callbacks which call the passed
// added/changed/removed/addedAt/changedAt/removedAt callbacks within
// observeChanges API
var translateToChangesCallbacks = function (changesCallbacks) {
  var newCallbacks = {};

  if (changesCallbacks.added)
    newCallbacks.added = function (doc) {
      var id = doc._id;
      delete doc._id;
      changesCallbacks.added(id, doc);
    };
  if (changesCallbacks.addedAt)
    newCallbacks.addedAt = function (doc, atIndex, before) {
      var id = doc._id;
      delete doc._id;
      changesCallbacks.addedBefore(id, doc, before);
    };

  var changedCallback = function (newDoc, oldDoc) {
    var id = newDoc._id;
    delete newDoc._id;
    // effectively the diff document is just {value} doc, as there is always
    // a single top-level field with the value
    changesCallbacks.changed(id, newDoc);
  };
  if (changesCallbacks.changed)
    newCallbacks.changed = changedCallback;
  if (changesCallbacks.changedAt)
    newCallbacks.changedAt = changedCallback;

  var removedCallback = function (doc) {
    changesCallbacks.removed(doc._id);
  };
  if (changesCallbacks.removed)
    newCallbacks.removed = removedCallback;
  if (changesCallbacks.removedAt)
    newCallbacks.removedAt = removedCallback;

  return newCallbacks;
};

_.extend(Miniredis.Cursor.prototype, {
  fetch: function () {
    var self = this;
    return self.redisStore.patternFetch(self.pattern);
  },
  count: function () {
    var self = this;
    // XXX Inefficient
    return self.fetch().length;
  },
  observe: function (callbacks) {
    var self = this;

    if (callbacks.addedAt || callbacks.changedAt || callbacks.removedAt || callbacks.movedTo) {
      return self.observe(translateToOrderedCallbacks(callbacks));
    }

    var observeRecord = _.extend({ pattern: self.pattern }, callbacks);
    var redisStore = self.redisStore;
    redisStore.observes.push(observeRecord);

    // XXX it is very important here to sort things in the same order they would
    // be sorted by the query definition (right now there is only one default
    // order).
    var docsInOrder = redisStore.patternFetch(self.pattern).sort(function (a, b) {
      return a.key.localeCompare(b.key);
    });
    _.each(docsInOrder, function (kv) {
      callbacks.added && callbacks.added({ _id: kv.key, value: kv.value  });
    });

    return {
      stop: function () {
        redisStore.observes = _.filter(redisStore.observes, function (obs) {
          return obs !== observeRecord;
        });
      }
    };
  },
  observeChanges: function (callbacks) {
    var self = this;

    if (callbacks.addedBefore || callbacks.movedBefore) {
      return self.observe(translateToChangesCallbacks(translateToOrderedCallbacks(callbacks)));
    }

    return self.observe(translateToChangesCallbacks(callbacks));
  },
  _getCollectionName: function () {
    var self = this;
    return self.redisStore.name;
  }
});

// A main store class
Miniredis.RedisStore = function (name) {
  var self = this;

  self.name = name;
  // main key-value storage
  self._kv = new IdMap(EJSON.stringify, EJSON.parse);
  // fine-grained reactivity per key
  self._keyDependencies = {};
  // fine-grained reactivity per non-trivial pattern
  self._patternDependencies = {};
  // originals saved in-between calls to saveOriginals and
  // retrieveOriginals
  self._savedOriginals = null;
  // list of observes on cursors
  self.observes = [];

  // True when observers are paused and we should not send callbacks.
  self.paused = false;
};

// Pause the observers. No callbacks from observers will fire until
// 'resumeObservers' is called.
Miniredis.RedisStore.prototype.pauseObservers = function () {
  var self = this;
  // XXX pauseObservers fails silenty if nested?
  // No-op if already paused.
  if (self.paused)
   return;

  // Set the 'paused' flag such that new observer messages don't fire.
  self.paused = true;

  // Take a snapshot of the query results
  self._kv = new CowIdMap(self._kv);
};

// Resume the observers. Observers immediately receive change
// notifications to bring them to the current state of the
// database. Note that this is not just replaying all the changes that
// happened during the pause, it is a smarter 'coalesced' diff.
Miniredis.RedisStore.prototype.resumeObservers = function () {
  var self = this;
  // No-op if not paused.
  if (! self.paused)
   return;

  // Unset the 'paused' flag. Make sure to do this first, otherwise
  // observer methods won't actually fire when we trigger them.
  self.paused = false;

  // Diff the current results against the snapshot and send to observers.
  self._kv._diffQueryChanges(_.bind(self._notifyObserves, self));

  // XXX Should we just always use a CowIdMap?
  self._kv = self._kv.flatten();

  // XXX Do we need observeQueue (should we put it into a common class)
  //self._observeQueue.drain();
};

var callInCallbackAndReturn = function (res, cb) {
  cb && Meteor.defer(function () { cb(undefined, res); });
  return res;
};

var callInCallbackOrThrow = function (err, cb) {
  if (cb) cb(err);
  else throw err;
};

var maybePopCallback = function (args) {
  return _.isFunction(_.last(args)) ? args.pop() : undefined;
};

_.extend(Miniredis.RedisStore.prototype, {
  // -----
  // convinience wrappers
  // -----
  _keyDep: function (key) {
    var self = this;

    if (! self._keyDependencies[key])
      self._keyDependencies[key] = new Deps.Dependency();

    if (Deps.active) {
      // for future clean-up
      Deps.onInvalidate(function () {
        self._tryCleanUpKeyDep(key);
      });
    }

    return self._keyDependencies[key];
  },
  _has: function (key) {
    var self = this;
    self._keyDep(key).depend();
    return self._kv.has(key);
  },
  _get: function (key) {
    var self = this;
    self._keyDep(key).depend();
    return self._kv.get(key);
  },
  _set: function (key, value) {
    var self = this;
    var oldValue = self._kv.has(key) ? self._kv.get(key) : undefined;
    self._kv.set(key, value);

    self._saveOriginal(key, oldValue);
    if (!self.paused && oldValue !== value) {
      if (oldValue === undefined) {
        self._notifyObserves(key, 'added', value);
      } else {
        self._notifyObserves(key, 'changed', value, oldValue);
      }
    }
  },

  _remove: function (key) {
    var self = this;
    if (! self._kv.has(key))
      return;
    var oldValue = self._kv.get(key);
    self._saveOriginal(key, oldValue);
    self._kv.remove(key);
    if (!self.paused)
      self._notifyObserves(key, 'removed', oldValue);
  },

  _tryCleanUpKeyDep: function (key) {
    var self = this;
    if (self._keyDependencies[key] && ! self._keyDependencies[key].hasDependents())
      delete self._keyDependencies[key];
  },

  _notifyObserves: function (key, event, value, oldValue) {
    var self = this;

    self._keyDep(key).changed();
    if (event === "removed") {
      self._tryCleanUpKeyDep(key);
    }

    if (event !== "changed") {
      _.each(self._patternDependencies, function (dep, pattern) {
        if (key.match(patternToRegexp(pattern))) {
          dep.changed();
        }
      });
    }

    _.each(self.observes, function (obs) {
      if (! key.match(patternToRegexp(obs.pattern)))
        return;
      if (event === "changed") {
        obs[event] && obs[event]({ _id: key, value: value },
                                 { _id: key, value: oldValue });
      } else {
        obs[event] && obs[event]({ _id: key, value: value });
      }
    });
  },

  _drop: function () {
    var self = this;
    self._kv.forEach(function (value, key) {
      self._remove(key);
    });
  },

  // -----
  // main interface built on top of Redis
  // -----

  call: function (method/*, args */) {
    var self = this;
    var args = _.toArray(arguments).slice(1);

    return self[method.toLowerCase()].apply(self, args);
  },

  patternFetch: function (pattern, cb) {
    var self = this;
    var res = [];
    var thrown = false;

    self._kv.forEach(function (value, key) {
      if (thrown || ! key.match(patternToRegexp(pattern)))
        return;
      self._keyDep(key).depend();

      if (_.isString(value))
        res.push({ key: key, value: value });
      else if (_.isObject(value))
        res.push({ key: key, value: value.toPlain() });
      else {
        callInCallbackOrThrow(new Error("Unknown type"), cb);
        thrown = true;
      }
    });

    if (thrown) return;

    if (! self._patternDependencies[pattern])
      self._patternDependencies[pattern] = new Deps.Dependency();
    self._patternDependencies[pattern].depend();

    if (Deps.active) {
      Deps.onInvalidate(function (c) {
        if (c.stopped)
          delete self._patternDependencies[pattern];
      });
    }

    return callInCallbackAndReturn(res, cb);
  },

  // Returns a Cursor
  matching: function (pattern) {
    var self = this;
    var c = new Miniredis.Cursor(self, pattern);
    return c;
  },

  // -----
  // implementing the contract of a data store
  // -----
  saveOriginals: function () {
    var self = this;
    if (self._savedOriginals)
      throw new Error("Called saveOriginals twice without retrieveOriginals");
    self._savedOriginals = new IdMap(EJSON.stringify, EJSON.parse);
  },

  retrieveOriginals: function () {
    var self = this;
    if (!self._savedOriginals)
      throw new Error("Called retrieveOriginals without saveOriginals");

    var originals = self._savedOriginals;
    self._savedOriginals = null;
    return originals;
  },

  _saveOriginal: function (key, value) {
    var self = this;
    if (! self._savedOriginals || self._savedOriginals.has(key))
      return;
    self._savedOriginals.set(key, value && { _id: key, value: value }); // XXX need to deep clone value?
  },

  // -----
  // general operators on keys
  // -----

  del: function (/* args */) {
    var self = this;
    var removedCount = 0;
    var args = _.toArray(arguments);
    var cb = maybePopCallback(args);
    _.each(args, function (key) {
      if (self._has(key)) {
        removedCount++;
        self._remove(key);
      }
    });

    return callInCallbackAndReturn(removedCount, cb);
  },
  exists: function (key, cb) {
    var self = this;
    var res = self._has(key) ? 1 : 0;
    return callInCallbackAndReturn(res, cb);
  },
  keys: function (pattern, cb) {
    if (! pattern)
      throw new Error("Wrong number of arguments for 'keys' command");
    var self = this;
    var res = _.pluck(self.matching(pattern).fetch(), 'key');
    return callInCallbackAndReturn(res, cb);
  },
  randomkey: function (cb) {
    var self = this;
    var res = Random.choice(_.keys(self._kv));
    return callInCallbackAndReturn(res, cb);
  },
  rename: function (key, newkey, cb) {
    if (key === newkey) {
      callInCallbackOrThrow(
        new Error("Source and destination objects are the same"), cb);
      return;
    }

    var self = this;

    if (! self._has(key)) {
      callInCallbackOrThrow(new Error("No such key"), cb);
      return;
    }

    var val = self._get(key);
    self._remove(key);
    self._set(newkey, val);

    return callInCallbackAndReturn(undefined, cb);
  },
  renamenx: function (key, newkey, cb) {
    var self = this;
    var res;

    if (self._has(newkey)) {
      res = 0;
    } else {
      self.rename(key, newkey);
      res = 1;
    }

    return callInCallbackAndReturn(res, cb);
  },
  sort: function (cb) {
    // This is a non-trivial operator that requires more thought on the design
    // and implementation. We probably want to implement this as it is the only
    // querying mechanism.
    throwNotImplementedError(cb);
  },
  type: function (key, cb) {
    var self = this;
    var type;

    // for unset keys the return value is "none"
    if (! self._has(key)) {
      type = "none";
    } else {
      var val = self._get(key);
      type = _.isString(val) ? "string" : val.type();
    }

    return callInCallbackAndReturn(type, cb);
  },

  // -----
  // operators on strings
  // -----

  append: function (key, value, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : "";

    if (! _.isString(val)) {
      throwIncorrectKindOfValueError(cb);
      return;
    }

    val += value;
    self._set(key, val);

    return callInCallbackAndReturn(val.length, cb);
  },
  decr: function (key, cb) {
    var self = this;
    self.decrby(key, 1);
    callInCallbackAndReturn(undefined, cb);
  },
  decrby: function (key, decrement, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : "0";

    if (! _.isString(val)) {
      throwIncorrectKindOfValueError(cb);
      return;
    }

    // cast to integer
    var newVal = val |0;

    if (val !== newVal.toString()) {
      callInCallbackOrThrow(
        new Error("Value is not an integer or out of range"), cb);
      return;
    }

    self._set(key, (newVal - decrement).toString());

    return callInCallbackAndReturn(undefined, cb);
  },
  get: function (key, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : null;
    if (val !== null && ! _.isString(val)) {
      throwIncorrectKindOfValueError(cb);
      return;
    }
    // Mirror mongo behaviour: missing get returns undefined
    if (val === null) {
      val = undefined;
    }

    return callInCallbackAndReturn(val, cb);
  },
  getrange: function (key, start, end, cb) {
    start = start || 0;
    end = end || 0;

    var self = this;
    var val = self._has(key) ? self._get(key) : "";

    if (! _.isString(val))
      throwIncorrectKindOfValueError(cb);
    if (val === "")
      return callInCallbackAndReturn("", cb);

    var len = val.length;
    var normalizedBounds = normalizeBounds(start, end, len);
    start = normalizedBounds.start;
    end = normalizedBounds.end;

    if (end < start)
      return callInCallbackAndReturn("", cb);

    return callInCallbackAndReturn(val.substr(start, end - start + 1), cb);
  },
  getset: function (key, value, cb) {
    var self = this;
    var val = self.get(key);
    self.set(key, value.toString());
    return callInCallbackAndReturn(val);
  },
  incr: function (key, cb) {
    var self = this;
    return self.incrby(key, 1, cb);
  },
  incrby: function (key, increment, cb) {
    var self = this;
    return self.decrby(key, -increment, cb);
  },
  incrbyfloat: function (key, increment, cb) {
    var self = this;
    var val = self._has(key) ? self._get(key) : "0";

    if (! _.isString(val))
      throwIncorrectKindOfValueError();

    // cast to float
    var newVal = parseFloat(val);

    if (isNaN(newVal))
      throw new Error("Value is not a valid float");

    self._set(key, (newVal + increment).toString());
    return callInCallbackAndReturn(undefined, cb);
  },
  mget: function (/* args */) {
    var self = this;
    var args = _.toString(arguments);
    var cb = maybePopCallback(args);
    var res = _.map(args, function (key) {
      return self.get(key);
    });

    callInCallbackAndReturn(res, cb);
  },
  mset: function (/* args */) {
    var self = this;
    var args = _.toString(arguments);
    var cb = maybePopCallback(args);

    for (var i = 0; i < args.length; i += 2) {
      var key = args[i];
      var value = args[i + 1];
      self.set(key, value);
    }

    return callInCallbackAndReturn(undefined, cb);
  },
  msetnx: function (/* args */) {
    var self = this;
    var args = _.toString(arguments);
    var cb = maybePopCallback(args);
    var res;

    if (_.all(args, function (key, i) {
      return (i % 2 === 1) || self._has(key);
    })) {
      self.mset.apply(self, args);
      res = 1;
    } else {
      res = 0;
    }

    return callInCallbackAndReturn(res, cb);
  },
  set: function (key, value, cb) {
    var self = this;
    self._set(key, value.toString());
    return callInCallbackAndReturn("OK", cb);
  },
  setex: function (key, expiration, value, cb) {
    // We rely on the server to do our expirations
    var self = this;
    return self.set(key, value, cb);
  },
  setnx: function (key, value, cb) {
    var self = this;
    if (self._has(key))
      return callInCallbackAndReturn(0, cb);
    self.set(key, value);
    return callInCallbackAndReturn(1, cb);
  },
  setrange: function (key, offset, value, cb) {
    // We probably should have an implementation for this one but it requires a
    // bit more thinking on how do we zero pad the string.
    throwNotImplementedError(cb);
  },
  strlen: function (key, cb) {
    var self = this;
    var val = self.get(key);
    var len = val ? val.length : 0;
    return callInCallbackAndReturn(len, cb);
  }
});

Miniredis.unsupportedMethods = ["ttl", "restore", "dump", "expire", "expireat",
  "migrate", "move", "object", "persist", "pexpire", "pexpireat", "pttl",
  "bitcount", "bitop", "bitops", "getbit", "setbit", "psetex",
  "blpop", "brpop", "brpoplpush", "rpoplpush"];

_.each(Miniredis.unsupportedMethods, function (method) {
  Miniredis.RedisStore.prototype[method] = throwNotImplementedError;
});

Miniredis.List = function () {
  this._list = [];
};

_.extend(Miniredis.List.prototype, {
  // since the Miniredis.List will always be used through RedisStore, there
  // is no point of extra type-checking
  lpush: function (/* values */) {
    var values = _.invoke(arguments, "toString");
    Array.prototype.splice.apply(this._list, [0, 0].concat(values));
    return this._list.length;
  },
  rpush: function (/* values */) {
    var values = _.invoke(arguments, "toString");
    Array.prototype.push.apply(this._list, values);
    return this._list.length;
  },
  lpop: function () {
    var val = this._list.splice(0, 1)[0];
    return val === undefined ? null : val;
  },
  rpop: function () {
    var val = this._list.pop();
    return val === undefined ? null : val;
  },
  lindex: function (index) {
    if (index < 0)
      index = this._list.length + index;
    var val = this._list[index];
    return val === undefined ? null : val;
  },
  linsert: function (beforeAfter, pivot, value) {
    var self = this;
    var pos = _.indexOf(self._list, pivot.toString());
    var isBefore = beforeAfter.toLowerCase() === "before";

    if (pos === -1)
      return -1;

    self._list.splice(isBefore ? pos : pos + 1, 0, value.toString());
    return self._list.length;
  },
  lrange: function (start, stop) {
    var self = this;
    var normalizedBounds = normalizeBounds(start, stop, self._list.length);
    start = normalizedBounds.start;
    stop = normalizedBounds.end;

    if (start > stop)
      return [];

    return self._list.slice(start, stop + 1);
  },
  lset: function (index, value) {
    if (index < 0)
      index = this._length + index;
    this._list[index] = value.toString();
  },
  ltrim: function (start, stop) {
    this._list = this.lrange(start, stop);
  },
  llen: function () {
    return this._list.length;
  },
  type: function () { return "list"; },
  toPlain: function () { return this._list.slice(0); },
  clone: function () {
    var list = new Miniredis.List();
    list._list = _.clone(this._list);
    return list;
  }
});

_.each(["lpushx", "rpushx"], function (method) {
  Miniredis.RedisStore.prototype[method] = function (key/* args */) {
    var self = this;

    if (! self._has(key))
      return 0;
    return self[method.slice(0, -1)].apply(self, arguments);
  };
});

_.each(["lpush", "rpush", "lpop", "rpop", "lindex", "linsert", "lrange",
        "lset", "ltrim", "llen"],
       function (method) {
         Miniredis.RedisStore.prototype[method] = function (key/*, args */) {
           var self = this;
           var args = _.toArray(arguments).slice(1);
           var cb = maybePopCallback(args);

           if (! self._has(key))
             self._set(key, new Miniredis.List);

           var list = self._get(key);
           if (! (list instanceof Miniredis.List)) {
             throwIncorrectKindOfValueError(cb);
             return;
           }

           var copy = list.clone();
           var res = Miniredis.List.prototype[method].apply(copy, args);
           self._set(key, copy);
           return callInCallbackAndReturn(res, cb);
         };
       });

// Hash implementation
Miniredis.Hash = function (map) {
  var self = this;
  self._map = map || {};
  self._didChange = false;
};

_.extend(Miniredis.Hash.prototype, {
  hset: function (field, value) {
    var map = this._map;
    var existed = _.has(map, field);

    if (! existed || map[field] !== value)
      this._didChange = true;

    map[field] = value;
    return existed ? 0 : 1;
  },
  hsetnx: function (field, value) {
    var map = this._map;
    var existed = _.has(map, field);
    if (! existed) {
      map[field] = value;
      this._didChange = true;
    }

    return existed ? 0 : 1;
  },
  hget: function (field) {
    return this._map[field];
  },
  hkeys: function () {
    return _.keys(this._map);
  },
  hvals: function () {
    return _.values(this._map);
  },
  hgetall: function () {
    return _.clone(this._map);
  },
  hincrby: function (field, delta) {
    var val = this._map[field];
    var newVal = (val || "0") |0;

    if (val !== newVal.toString())
      throw new Error("Hash value is not an integer.");

    this._map[field] = (newVal - -delta).toString();

    if (this._map[field] !== val)
      this._didChange = true;

    return this._map[field];
  },
  hincrbyfloat: function (field, delta) {
    var val = this._map[field];
    var newVal = parseFloat(val || "0");

    if (isNaN(newVal))
      throw new Error("Hash value is not a valid float.");

    this._map[field] = (newVal - -delta).toString();

    if (this._map[field] !== val)
      this._didChange = true;

    return this._map[field];
  },
  hdel: function (/* args */) {
    var args = _.toArray(arguments);
    var self = this;
    return _.reduce(args, function (removed, field) {
      if (! _.has(self._map, field))
        return removed;
      delete self._map[field];
      self._didChange = true;
      return removed + 1;
    }, 0);
  },
  hmset: function (/* args */) {
    var args = _.toArray(arguments);
    var self = this;
    var map = self._map;

    var changeFn = function (value, key) {
      self.hset(key, value);
    };

    if (args.length === 1 && _.isObject(args[0])) {
      // a short hand form of a map
      _.each(args[0], changeFn);
    } else {
      // a traditional syntax with key-value pairs
      for (var i = 0; i + 1 < args.length; i += 2) {
        var key = args[i];
        var value = args[i + 1];
        changeFn(value, key);
      }
    }
    return "OK";
  },
  hmget: function (/* args */) {
    var args = _.toArray(arguments);
    var map = this._map;
    return _.map(args, function (field) {
      return map[field];
    });
  },
  hlen: function () {
    return this.hkeys().length;
  },
  hexists: function (field) {
    return _.has(this._map, field) ? 1 : 0;
  },
  // XXX no hscan?

  // Miniredis data-structure interface
  type: function () { return "hash"; },
  clone: function () {
    var copy = new Miniredis.Hash(_.clone(this._map));
    return copy;
  },
  toPlain: function () { return this._map; },
  _isEmpty: function () { return _.isEmpty(this._map); },

  // EJSONable type interface
  typeName: function () { return "redis-hash" },
  toJSONValue: function () {
    return JSON.stringify(this._map);
  }
});

EJSON.addType("redis-hash",  function (map) {
  return new Miniredis.Hash(JSON.parse(map));
});


_.each(["hset", "hsetnx", "hget", "hkeys", "hvals", "hgetall", "hincrby",
        "hincrbyfloat", "hdel", "hmset", "hmget", "hlen", "hexists"],
       function (method) {
         Miniredis.RedisStore.prototype[method] = function (key/*, args */) {
           var self = this;
           var args = _.toArray(arguments).slice(1);
           var cb = maybePopCallback(args);

           var hash = self._get(key);

           if (! self._has(key)) {
             if (_.contains(["hget", "hkeys", "hvals", "hgetall"], method)) {
               return callInCallbackAndReturn(undefined, cb);
             }
             hash = new Miniredis.Hash;
           }

           if (! (hash instanceof Miniredis.Hash)) {
             throwIncorrectKindOfValueError(cb);
             return;
           }

           var copy = hash;

           copy = hash.clone();

           try {
             var res = Miniredis.Hash.prototype[method].apply(copy, args);
           } catch (err) {
             callInCallbackOrThrow(err, cb);
             return;
           }

           if (copy._didChange && ! copy._isEmpty())
             self._set(key, copy);
           copy._didChange = false;

           // a special case for removing the last field in a hash
           if (copy._isEmpty())
             self._remove(key);

           return callInCallbackAndReturn(res, cb);
         };
       });

function normalizeBounds (start, end, len) {
  // put start and end into [0, len) range
  start %= len;
  if (start < 0)
    start += len;
  if (end >= len)
    end = len - 1;
  end %= len;
  if (end < 0)
    end += len;
  return { start: start, end: end };
}

function patternToRegexp (pattern) {
  // all special chars except for [, ], *, ?
  // - as they are used as is in patterns
  var specialChars = ".\\^$()+{}";
  var regexpStr = "^";

  _.each(pattern, function (ch) {
    if (_.contains(specialChars, ch))
      regexpStr += "\\";

    // "match one" operator
    if (ch === "?")
      ch = ".";
    // "match any number of chars" operator
    if (ch === "*")
      ch = ".*";

    regexpStr += ch;
  });

  regexpStr += "$";

  return new RegExp(regexpStr);
}

Miniredis.patternToRegexp = patternToRegexp;






// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------

Miniredis.Set = function () {
  this._set = [];
};

Miniredis.Set.sunion = function (setsMembers) {
  var flat = _.flatten(setsMembers);
  var res = _.uniq(flat);
  return res;
};

Miniredis.Set.sdiff = function (setsMembers) {
  var base = setsMembers.shift();
  var sub = _.flatten(setsMembers);
  return _.difference(base, sub);
};

_.extend(Miniredis.Set.prototype, {
  smembers: function () {
    return (this._set.length > 0) ? this._set : undefined;
  },
  sadd: function (/* values */) {
    var set = this._set;
    var values = _.invoke(arguments, "toString");
    var insertCount = 0;
    values.forEach(function(val) {
      if (_.contains(set, val)) return;
      set.push(val);
      insertCount ++;
    });
    return insertCount;
  },
  scard: function () {
    return this._set.length;
  },
  sismember: function (value) {
    var set = this._set;
    return _.contains(set, value) ? 1 : 0;
  },
  srandmember: function (num) {
    var sample;
    var set = this._set;
    if (num === undefined) {
      sample = _.sample(set);
    } else if (num < 0) {
      var sample = [];
      var num = Math.abs(num);
      for (var i = 0; i < num; i++) {
        sample.push(_.sample(set));
      }
    } else {
      sample = _.sample(set, num);
    }
    return sample;
  },
  srem: function (/* values */) {
    var self = this;
    var values = _.invoke(arguments, "toString");
    var count = 0;
    values.forEach(function(val) {
      var index = self._set.indexOf(val);
      if (index === -1) return;
      self._set.splice(index, 1);
      count ++;
    });
    return count;
  },
  clone: function () {
    var set = new Miniredis.Set();
    set._set = _.clone(this._set);
    return set;
  }
});


_.each(["sunion", "sdiff"],
  function (method) {
    Miniredis.RedisStore.prototype[method] = function (/* keys */) {
      var self = this;
      var keys = _.toArray(arguments);
      var cb = maybePopCallback(keys);

      var setsMembers = [];
      keys.forEach(function(key) {
        var members = self.smembers(key);
        setsMembers.push(members);
      });

      var res = Miniredis.Set[method](setsMembers);
      return callInCallbackAndReturn(res, cb);
    };
  });

_.each(["smembers", "sadd", "scard", "sismember", "srandmember", "srem"],
  function (method) {
    Miniredis.RedisStore.prototype[method] = function (key/*, args */) {
      var self = this;
      var args = _.toArray(arguments).slice(1);
      var cb = maybePopCallback(args);

      if (! self._has(key))
       self._set(key, new Miniredis.Set);

      var set = self._get(key);
      if (! (set instanceof Miniredis.Set)) {
       throwIncorrectKindOfValueError(cb);
       return;
      }

      var copy = set.clone();
      var res = Miniredis.Set.prototype[method].apply(copy, args);
      self._set(key, copy);
      return callInCallbackAndReturn(res, cb);
    };
  });
