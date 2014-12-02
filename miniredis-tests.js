Tinytest.add("miniredis - pattern matching", function (test) {
  var regexp = null;
  function T (str) { test.isTrue(str.match(regexp)); }
  function F (str) { test.isFalse(str.match(regexp)); }

  regexp = Miniredis.patternToRegexp("H*llo");
  T("Hello");
  T("Hllo");
  T("Hallo");
  T("H123llo");
  T("H12  3llo");
  F("1H12  3llo");
  F("Hllo ");
  F(" Hllo ");

  regexp = Miniredis.patternToRegexp("Pattern");
  T("Pattern");
  F("pattern");
  F("Pattern ");

  regexp = Miniredis.patternToRegexp("Str?ngs");
  T("Strings");
  T("Strangs");
  T("Str5ngs");
  F("Strngs");
  F("Stringss");

  regexp = Miniredis.patternToRegexp("Varia**tio[^nNmM]");
  T("Variation");
  T("VariatioN");
  T("Variatiom");
  T("Varia66tio^");
  F("Variatio:");
  F("Variatio?");

  regexp = Miniredis.patternToRegexp("x?:()x");
  T("xA:()x");
  T("x.:()x");
  F("x.:)(x");
});

Tinytest.add("miniredis - strings operations", function (test) {
  var S = new Miniredis.RedisStore();

  test.equal(S.get("key"), undefined);
  S.set("key", 123);
  test.equal(S.get("key"), "123");
  test.equal(S.append("key", "45"), 5);
  test.equal(S.get("key"), "12345");
  S.incrby("key", 4);
  test.equal(S.get("key"), "12349");
  S.decrby("key", "11");
  test.equal(S.get("key"), "12338");
  test.equal(S.strlen("key"), 5);
  test.equal(S.getrange("key", -3, -1), "338");
  test.equal(S.getset("key", "newstring"), "12338");
  test.equal(S.get("key"), "newstring");
});

Tinytest.add("miniredis - lists operations", function (test) {
  var S = new Miniredis.RedisStore();
  test.equal(S.get("k"), undefined);
  S.lpushx("k", "0");
  test.equal(S.get("k"), undefined);
  S.rpushx("k", "0");
  test.equal(S.get("k"), undefined);
  S.rpush("k", "1");
  test.throws(function () { S.get("k"); }, /wrong kind/);
  test.equal(S.lindex("k", 0), "1");
  S.lpushx("k", 0);
  test.equal(S.lindex("k", 0), "0");
  S.lpush("k", "a");
  test.equal(S.lindex("k", 0), "a");
  test.equal(S.lindex("k", 1), "0");
  test.equal(S.lindex("k", 2), "1");
  S.rpush("k", 2, 3, 4, 5);
  test.equal(S.lindex("k", 3), "2");
  test.equal(S.lindex("k", 4), "3");
  test.equal(S.lindex("k", 5), "4");
  test.equal(S.lindex("k", 6), "5");
  test.equal(S.llen("k"), 7);
  test.equal(S.lrange("k", 2, -2), ["1", "2", "3", "4"]);
  S.linsert("k", "BEFORE", "0", "-1");
  test.equal(S.lrange("k", 0, 7), ["a", "-1", "0", "1", "2", "3", "4", "5"]);
  S.linsert("k", "AFTER", "a", "b");
  test.equal(S.lrange("k", 0, 8), ["a", "b", "-1", "0", "1", "2", "3", "4", "5"]);
  test.equal(S.lpop("k"), "a");
  test.equal(S.lpop("k"), "b");
  test.equal(S.lpop("k"), "-1");
  test.equal(S.llen("k"), 6);
  test.equal(S.rpop("k"), "5");
  test.equal(S.rpop("k"), "4");
  test.equal(S.llen("k"), 4);
  S.lset("k", "2", "3");
  test.equal(S.lrange("k", 0, 3), ["0", "1", "3", "3"]);
  // XXX implement and test LREM
});

Tinytest.add("miniredis - hashes operations", function (test) {
  var S = new Miniredis.RedisStore();
  S.hsetnx("h", "a-field", "a-value");
  test.equal(S.hget("h", "a-field"), "a-value");
  S.hsetnx("h", "a-field", "b-value");
  test.equal(S.hget("h", "a-field"), "a-value");
  S.hset("h", "a-field", "b-value");
  test.equal(S.hget("h", "a-field"), "b-value");
  test.throws(function () { S.get("h"); }, /wrong kind/);
  S.hset("h", "b-field", "c-value");
  test.equal(S.hget("h", "b-field"), "c-value");
  test.equal(S.hkeys("h"), ["a-field", "b-field"]);
  test.equal(S.hvals("h"), ["b-value", "c-value"]);
  test.equal(S.hgetall("h"), {"a-field": "b-value", "b-field": "c-value"});
  S.hset("h", "c-field", "42");
  S.hincrby("h", "c-field", "13");
  S.hdel("h", "a-field", "b-field");
  test.equal(S.hgetall("h"), {"c-field": "55"});
  S.hincrbyfloat("h", "c-field", "0.5");
  test.equal(S.hgetall("h"), {"c-field": "55.5"});
  S.hmset("h", { "A": "A", "B": "B" });
  test.equal(S.hgetall("h"), {"c-field": "55.5", "A": "A", "B": "B"});
  S.hmset("h", "A", "a", "C", "c");
  test.equal(S.hgetall("h"), {"c-field": "55.5", "A": "a", "B": "B", "C": "c"});
  test.equal(S.hlen("h"), 4);
  test.equal(S.hmget("h", "A", "B"), ["a", "B"]);
  test.equal(S.hexists("h", "A"), 1);
  test.equal(S.hexists("h", "e"), 0);

  // after deleting everyting from the hash, the whole hash is removed and we
  // can set it to anything
  S.hdel("h", "A", "B", "C", "c-field");
  S.set("h", "str");
  test.equal(S.get("h"), "str");
});


Tinytest.add("miniredis - sets operations", function (test) {
  var S = new Miniredis.RedisStore();
  test.equal(S.smembers("myset"), undefined);

  test.equal(S.sadd("myset", "a-value"), 1);
  test.equal(_.contains(S.smembers("myset"), 'a-value'), true);
  test.equal(S.smembers("otherset"), undefined);
  test.equal(S.scard("myset"), 1);

  test.equal(S.sadd("myset", "b-value", "c-value"), 2);
  test.equal(_.contains(S.smembers("myset"), 'b-value'), true);
  test.equal(_.contains(S.smembers("myset"), 'c-value'), true);

  S.sadd("myset", "a-value");
  test.equal(S.scard("myset"), 3);

  test.equal(S.sismember("myset", "a-value"), 1);
  test.equal(S.sismember("myset", "d-value"), 0);

  S.sadd("otherset", "z-value", "a-value");
  var sunionRes = S.sunion("myset", "otherset");
  test.equal(sunionRes.length, 4);
  test.equal(_.contains(sunionRes, 'a-value'), true);
  test.equal(_.contains(sunionRes, 'b-value'), true);
  test.equal(_.contains(sunionRes, 'c-value'), true);
  test.equal(_.contains(sunionRes, 'z-value'), true);

  var sdiffRes = S.sdiff("myset", "otherset");
  test.equal(sdiffRes.length, 2);
  test.equal(_.contains(sdiffRes, 'b-value'), true);
  test.equal(_.contains(sdiffRes, 'c-value'), true);
  S.sadd("myset", "z-value");
  sdiffRes = S.sdiff("otherset", "myset");
  test.equal(sdiffRes, []);

  var members = S.smembers('myset');
  var srandmember = S.srandmember('myset');
  test.equal(typeof srandmember, "string");
  test.equal(_.contains(members, srandmember), true);
  srandmember = S.srandmember('myset', 2);
  test.equal(typeof srandmember, "object");
  test.equal(srandmember.length, 2);
  test.equal(_.contains(members, srandmember[0]), true);
  test.equal(_.contains(members, srandmember[1]), true);
  srandmember = S.srandmember('myset', 5);
  test.equal(srandmember.length, 4);
  srandmember = S.srandmember('myset', -9);
  test.equal(srandmember.length, 9);

  test.equal(S.smembers('myset').length, 4);
  test.equal(S.srem('myset', 'z-value'), 1);
  test.equal(S.smembers('myset').length, 3);
  test.equal(_.contains(S.smembers('myset'), 'z-value'), false);
  test.equal(S.srem('myset', 'b-value', 'c-value', 'q-value'), 2);
  test.equal(S.smembers('myset').length, 1);
  test.equal(_.contains(S.smembers("myset"), 'a-value'), true);
});
