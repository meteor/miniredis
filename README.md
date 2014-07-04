# Miniredis

This is an all-javascript in-memory implementation of the [Redis](https://redis.io) API,
adapted for Meteor.

```javascript
var redis = new Miniredis.RedisStore;
redis.set("key-1-1", "foo");
redis.set("key-1-2", "bar");
```

You can install it with meteorite:

    mrt install miniredis

## Reactivity

This implementation supports
[Deps.js](https://github.com/meteor/meteor/blob/devel/packages/deps)
reactivity with fine-grained reactivity: if a command was run in a
Deps.autorun computation, then the minimal set of dependencies will be tracked.

```javascript
var redis = new Miniredis.RedisStore;
redis.set("key-1-1", "foo");

Deps.autorun(function () {
  console.log(_.pluck(redis.matching("key-1-*").fetch()));
});
// prints ["foo"]

redis.set("key-2-1", "baz");
// doesn't print anything

redis.set("key-1-2", "bar");
// prints ["foo", "bar"]

redis.set("key-1-1", "foo1");
// prints ["foo1", "bar"]
```

## Observe API

Similar to Minimongo's Cursor's, Miniredis Cursors (as returned by
`redis.matching("*-pattern-*")` calls) can be observed with `added`, `changed`
and `removed` callbacks.

```javascript
redis.matching("key-2-*").observe({
  added: function (item) { /* item: { _id, value } */ },
  changed: function (item, oldItem) { /* item: { _id, value} */ },
  removed: function (item) { /* item: { _id, value } */ }
});
```

You can also have an ordered observe by passing `addedAt`, `changedAt`,
`removedAt` callbacks. The current order is the lexicographical order of keys.

```javascript
redis.matching("key-2-*").observe({
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
redis.pauseObservers();
// Make a lot of changes
_.each(removedValues, function (value, key) {
  redis.del(key);
});
_.each(newValues, function (value, key) {
  redis.set(key, value);
});
// Resume
redis.resumeObservers();
```

## Blaze compatibility

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
  return redis.matching("key-2-*");
};
```

## Redis API compatibility

To support [Meteor](https://www.meteor.com)'s latency compensation,
this implementation tries to mimic the behavior of the Redis server.

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

- hset
- hsetnx
- hget
- hkeys
- hvals
- hgetall
- hincrby
- hincrbyfloat
- hdel
- hmset
- hmget
- hlen
- hexists

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

