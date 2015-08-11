/**
 * Server I/O
 *
 * Provides a way to interact with the Twitch chat servers
 * Communication is done with the IRC protocol but over webSockets, via tmi.js.
 *
 * @ngdoc factory
 * @name irc
 * @type {object}
 *
 * @fires irc#tmi-events                  - Rebroadcasts events from tmi.js
 *
 * @property {boolean} ready              - True if connected to the server
 * @property {boolean} badLogin           - True if currently disconnected because of credentials
 *
 * @property {function} say               - Send a message to the server
 * @property {function} whisper           - Send a whisper to the server
 * @property {function} isMod             - Check if a user is a mode in a channel
 * @property {function} credentialsValid  - Returns true if the credentials appear valid. Not verified server side
 */
angular.module('tc').factory('irc', function($rootScope, $timeout, $q, settings, _) {

	//===============================================================
	// Variables
	//===============================================================
	var Emitter = require('events').EventEmitter;
	var ee = new Emitter();
	var clients = {read: null, write: null, whisper: null};
	var tmi = (function() {
		// if tmi.js detects a window object, require() doesn't
		// properly return a constructor. Band aid hack
		require('tmi.js');
		return window.irc;
	})();

	//===============================================================
	// Public members
	//===============================================================
	ee.ready = false;
	ee.badLogin = false;
	ee.credentialsValid = credentialsValid;

	ee.isMod = function(channel, username) {
		return clients.write.isMod(channel, username);
	};

	ee.say = function(channel, message) {
		clients.write.say(channel, message);
	};

	ee.whisper = function(username, message) {
		clients.whisper.whisper(username, message);
	};

	// TODO debug stuff
	window.ircFactory = ee;
	window.clients = clients;
	window.$rootScope = $rootScope;

	//===============================================================
	// Setup
	//===============================================================
	if (credentialsValid()) create();

	onBadLogin(destroy);
	onValidCredentials(create);
	onInvalidCredentials(destroy);
	onChannelsChange(syncChannels);

	//===============================================================
	// Private methods
	//===============================================================

	function create() {
		destroy();
		ee.badLogin = false;

		// Disconnected is handled elsewhere
		var readEvents = [
			'action', 'chat', 'clearchat', 'connected', 'connecting', 'crash',
			'hosted', 'hosting', 'slowmode', 'subanniversary',
			'subscriber', 'subscription', 'timeout', 'unhost'
		];

		var clientSettings = {
			options: {debug: false},
			connection: {random: 'chat', timeout: 10000, reconnect: true},
			identity: settings.identity,
			channels: settings.channels
		};

		_.forEach(clients, function(v, key) {
			var setts = angular.copy(clientSettings);
			if (key === 'whisper') {
				setts.connection.random = 'group';
				setts.channels = [];
			}
			clients[key] = new tmi.client(setts);
			if (setts.channels) clients[key].tcCurrentChannels = angular.copy(setts.channels);
			clients[key].connect();
		});

		forwardEvents(clients.read, ee, readEvents);
		forwardEvents(clients.whisper, ee, ['whisper']);

		clients.read.on('disconnected', function(reason) {
			if (reason === 'Login unsuccessful.') {
				ee.badLogin = reason;
				settings.identity.password = '';
			}
			ee.ready = false;
			process.nextTick(function() {$rootScope.$apply();});
		});

		console.log('IRC: registering connected event');
		clients.read.on('connected', function() {
			console.log('IRC: connected event fired');
			ee.ready = true;
			process.nextTick(function() {$rootScope.$apply();});
		});

		// Disconnected event gets spammed on every connection
		// attempt. This is not ok if the internet is temporarily
		// down, for example.
		onlyEmitDisconnectedOnce();

		function onlyEmitDisconnectedOnce() {
			clients.read.once('disconnected', function() {
				var args = Array.prototype.slice.call(arguments);
				args.unshift('disconnected');
				ee.emit.apply(ee, args);
				clients.read.once('connected', onlyEmitDisconnectedOnce);
			});
		}
	}

	function destroy() {
		_.forEach(clients, function(client, key) {
			if (client) {
				client.removeAllListeners();
				client.disconnect();
				clients[key] = null;
			}
		});
	}

	/**
	 * Re emits events from `emitter` on `reEmitter`
	 * @param {Object}   emitter   - Emits events to rebroadcast. Has .addListener()
	 * @param {Object}   reEmitter - The object that will rebroadcast. Has .emit()
	 * @param {String[]} events    - The events to listen for on `emitter`
	 */
	function forwardEvents(emitter, reEmitter, events) {
		events.forEach(function(event) {
			emitter.addListener(event, function() {
				var args = Array.prototype.slice.call(arguments);
				args.unshift(event);
				reEmitter.emit.apply(reEmitter, args);
			});
		});
	}

	/**
	 * Makes sure the clients are connected to the
	 * correct channels, the ones in the settings.
	 */
	function syncChannels() {
		[clients.read, clients.write].forEach(function(client) {
			joinChannels(client);
			leaveChannels(client);
		})
	}

	/**
	 * Joins any channels in settings.channels
	 * that haven't been joined yet.
	 */
	function joinChannels(client) {
		settings.channels.forEach(function(channel) {
			console.log('checking if need to join '+channel);
			if (client.tcCurrentChannels.indexOf(channel) === -1) {
				client.join(channel);
				client.tcCurrentChannels.push(channel);
			}
		});
	}

	/**
	 * Leaves joined channels that do not
	 * appear in settings.channels.
	 */
	function leaveChannels(client) {
		// Need for loop for the index.
		// Backwards so that array changes don't affect the loop
		for (var i = client.tcCurrentChannels.length - 1; i > -1; i--) {
			var channel = client.tcCurrentChannels[i];
			if (settings.channels.indexOf(channel) === -1) {
				client.part(channel);
				client.tcCurrentChannels.splice(i, 1);
			}
		}
	}

	/**
	 * When a client disconnects due to unsuccessful login,
	 * sets ee.badLogin and deletes the password from settings.
	 * This should cause the login form to display with an error.
	 * Uses observers to attach this behavior to future client instances.
	 */
	function onBadLogin(cb) {

		if (clients.read) attachBadLoginCheck();

		//noinspection JSCheckFunctionSignatures
		Object.observe(clients, function(changes) {
			changes.forEach(function(change) {
				if (change.name === 'read') attachBadLoginCheck();
			});
		}, ['update']);

		function attachBadLoginCheck() {
			clients.read.on('disconnected', function(reason) {
				if (reason === 'Login unsuccessful.') {
					ee.badLogin = reason;
					settings.identity.password = '';
					process.nextTick(function() {$rootScope.$apply();});
					cb();
				}
			});
		}
	}

	function onChannelsChange(cb) {
		$rootScope.$watchCollection(
			function watchVal() {return settings.channels;},
			function handler(newV, oldV) {
				if (newV !== oldV) cb();
			}
		);
	}

	function onInvalidCredentials(cb) {
		onCredentialsValidChange(function(valid) {
			if (!valid) cb();
		})
	}

	function onValidCredentials(cb) {
		onCredentialsValidChange(function(valid) {
			if (valid) cb();
		})
	}

	function onCredentialsValidChange(cb) {
		// TODO change this so it doesn't run for each call
		$rootScope.$watch(credentialsValid, function(newv, oldv) {
				if (oldv !== newv) cb(newv);
			}
		);
	}

	function credentialsValid() {
		return !!settings.identity.username.length && !!settings.identity.password.length;
	}

	return ee;
});