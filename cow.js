// A copy-on-write IdMap
// Avoids deep-copying all the objects in a collection; we instead keep
// a separate map just of the objects we've changed.
// This does rely on the caller not changing objects return from get.
CowIdMap = function (original) {
  var self = this;

  self._original = original;
  self._changes = new IdMap(original._idStringify, original._idParse);

  // XXX Should we maintain a combined list (of references, not deep-copies),
  // to avoid double-lookup?  Probably, because we always call flatten...
  //self._combined = new IdMap(original._idStringify, original._idParse);
};

var TOMBSTONE = {};

CowIdMap.prototype.remove = function (key) {
  var self = this;

  self._changes.set(key, TOMBSTONE);
};

CowIdMap.prototype.has = function (key) {
  var self = this;

  var v = self._changes.get(key);
  if (v === undefined) {
    return self._original.has(key);
  } else if (v === TOMBSTONE) {
    return false;
  } else {
    return true;
  }
};

// Do not change the returned value.
// Instead, copy and set.
CowIdMap.prototype.get = function (key) {
  var self = this;

  var v = self._changes.get(key);
  if (v === undefined) {
    return self._original.get(key);
  } else if (v === TOMBSTONE) {
    return undefined;
  } else {
    return v;
  }
};

CowIdMap.prototype.set = function (key, value) {
  var self = this;

  self._changes.set(key, value);
};


CowIdMap.prototype.forEach = function (iterator) {
  var self = this;

  var breakIfFalse = undefined;

  self._changes.forEach(function (value, id) {
    if (value === TOMBSTONE) {
      return true;
    }
    breakIfFalse = iterator.call(null, value, id);
    return breakIfFalse;
  });

  if (breakIfFalse === false) {
    return;
  }

  self._original.forEach(function (value, id) {
    if (self._changes.has(id)) {
      return true;
    }
    return iterator.call(null, value, id);
  });
};

CowIdMap.prototype._diffQueryChanges = function (callback) {
  var self = this;

  self._changes.forEach(function (value, id) {
    var oldValue = self._original.get(id);

    if (value === TOMBSTONE) {
      // Deleted
      if (oldValue !== undefined) {
        callback(id, 'removed', value);
      }
    } else if (oldValue === undefined) {
      // Added
      callback(id, 'added', value);
    } else {
      // Changed
      if (!EJSON.equals(oldValue, value)) {
        callback(id, 'changed', value, oldValue);
      }
    }

    return true;
  });
};

CowIdMap.prototype.flatten = function () {
  var self = this;
  var original = self._original;

  var flat = new IdMap(original._idStringify, original._idParse);

  self._original.forEach(function (value, id) {
    flat.set(id, value);
  });

  self._changes.forEach(function (value, id) {
    if (value === TOMBSTONE) {
      flat.remove(id);
    } else {
      flat.set(id, value);
    }
  });

  return flat;
};
