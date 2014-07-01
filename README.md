# Miniredis

This is all-javascript in-memory implementation of [Redis](https://redis.io) API
adapted for Meteor.

```javascript
var Redis = new Miniredis.RedisStore;
Redis.set("key-1-1", "foo");
Redis.set("key-1-2", "bar");
```

You can install it with meteorite:

    mrt install miniredis

## Reactivity

This implementation supports
[Deps.js](https://github.com/meteor/meteor/blob/devel/packages/deps)
reactivity with fine-grained reactivity: if a command was run in a
Deps.autorun computation, then the minimal set of dependencies will be tracked.

```javascript
var Redis = new Miniredis.RedisStore;
Redis.set("key-1-1", "foo");

Deps.autorun(function () {
  console.log(_.pluck(Redis.matching("key-1-*").fetch()));
});
// prints ["foo"]

Redis.set("key-2-1", "baz");
// doesn't print anything

Redis.set("key-1-2", "bar");
// prints ["foo", "bar"]

Redis.set("key-1-1", "foo1");
// prints ["foo1", "bar"]
```

## Observe API

Similar to Minimongo's Cursor's, Miniredis Cursors (gathered from
`Redis.matching("*-pattern-*")` calls) can be observed with `added`, `changed`
and `removed` callbacks.

```javascript
Redis.matching("key-2-*").observe({
  added: function (item) { /* item: { _id, value } */ },
  changed: function (item, oldItem) { /* item: { _id, value} */ },
  removed: function (item) { /* item: { _id, value } */ }
});
```

You can also have an ordered observe by passing `addedAt`, `changedAt`,
`removedAt` callbacks. The current order is the lexicographical order of keys.

```javascript
Redis.matching("key-2-*").observe({
  addedAt: function (item, atIndex, before) { /* item: { _id, value } */ },
  changedAt: function (item, oldItem, atIndex) { /* item: { _id, value} */ },
  removedAt: function (item, atIndex) { /* item: { _id, value } */ }
});
```

`observeChanges` is also implemented but it is not very different from the
`observe` version as of yet.

You can pause/resume observers with the same API as of Minimongo:

```javascript
// Pause observers
Redis.pauseObservers();
// Batch the updates
_.each(removedValues, function (value, key) {
  Redis.del(key);
});
_.each(newValues, function (value, key) {
  Redis.set(key, value);
});
// Resume
Redis.resumeObservers();
```

## Blaze compitability

Miniredis's cursors can be observed by [Blaze](http://meteor.github.io/blaze):

```html
<template name="orderedList">
  {{#each listItems}}
    <div>{{_id}} - {{value}}</div>
  {{/each}}
</template>
```

```javascript
Template.orderedList.listItems = function () {
  return Redis.matching("key-2-*");
};
```

## Redis API compitability

In order to have a well-working latency compensation in the context of
[Meteor](https://www.meteor.com) this implementation tries to mimic the behavior
of real Redis.

Right now these Redis commands are implemented and available:

### On Strings

- set
- get
- del
- exists
- keys
- randomkey
- rename
- renamenx
- type
- append
- decr
- decrby
- getrange
- getset
- incr
- incrby
- incrbyfloat
- mget
- mset
- msetnx
- setx
- setnx
- setrange
- strlen

### On Hashes

- hgetall
- hmset
- hincrby

### On Lists

- lpush
- rpush
- lpop
- rpop
- lindex
- linsert
- lrange
- lset
- ltrim
- llen
- lpushx
- rpushx

## License

MIT (c) Meteor Development Group

