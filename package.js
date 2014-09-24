Package.describe({
  summary: "Meteor's client-side datastore: a port of Redis to Javascript",
  version: "1.0.0",
  name: "slava:miniredis",
  git: "https://github.com/meteor/miniredis"
});

Package.on_use(function (api) {
  api.export('Miniredis');
  api.use(['id-map', 'deps', 'underscore', 'random', 'ejson']);
  api.add_files(['cow.js', 'miniredis.js']);
});

Package.on_test(function (api) {
  api.use('miniredis', ['client', 'server']);
  api.use('test-helpers', 'client');
  api.use(['tinytest', 'underscore', 'ejson', 'ordered-dict',
           'random', 'deps']);
  api.add_files('miniredis-tests.js');

  // Usually using Deps on the server is not a good idea
  api.add_files('miniredis-reactivity-tests.js', 'client');
  // ObserveChanges is available regardless of Deps
  api.add_files('miniredis-observe-tests.js');
});

