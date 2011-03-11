/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is DownThemAll! QueueStore module.
 *
 * The Initial Developer of the Original Code is Nils Maier
 * Portions created by the Initial Developers are Copyright (C) 2007-2009
 * the Initial Developers. All Rights Reserved.
 *
 * Contributor(s):
 *    Stefano Verna <stefano.verna@gmail.com>
 *    Federico Parodi <jimmy2k@gmail.com>
 *    Nils Maier <MaierMan@web.de>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

"use strict";

var EXPORTED_SYMBOLS = ['QueueStore'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const module = Components.utils.import;
const Exception = Components.Exception;

const DB_FILE = 'dta_queue.sqlite';
const DB_FILE_BROKEN = 'dta_queue.broken';
const DB_FILE_BAK = DB_FILE + ".bak";
const DB_VERSION = 1;

const STMT_SELECT = 'SELECT uuid, item FROM queue ORDER BY pos';

module("resource://dta/utils.jsm");

let pbm = {};
module("resource://dta/support/pbm.jsm", pbm);
module("resource://dta/support/timers.jsm");

const Timers = new TimerManager();

ServiceGetter(this, "Storage", "@mozilla.org/storage/service;1", "mozIStorageService");
ServiceGetter(this, "Observers", "@mozilla.org/observer-service;1", "nsIObserverService");

let _connection = null;
let _saveStmt = null;
let _saveStmtParams = null;
let _timer = 0;


setNewGetter(this, '__db', function() {
	let db = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
	db.append(DB_FILE);
	return db;
});
setNewGetter(this, '_asyncStatement', function() {
	if ('createAsyncStatement' in _connection) {
		return _connection.createAsyncStatement;
	}
	return _connection.createStatement;
});

const QueueStore = {
	_initialized: false,
	_private: false,
	init: function(pb) {
		if (this._initialized) {
			return;
		}
		this._initialized = true;

		Debug.log("QueueStore: initialzing in " + (pb ? "private" : "normal") + " mode");

		try {
			if (pb) {
				_connection = Storage.openSpecialDatabase("memory");
				this._private = true;
			}
			else {
				_connection = Storage.openDatabase(__db);
				this._private = false;
			}
		}
		catch (ex) {
			if (!pb) {
				Debug.log("DB appears broken; backing up and restart", ex);
				try {
					let cbroken = __db.clone();
					cbroken.leafName = DB_FILE_BROKEN;
					if (cbroken.exists()) {
						cbroken.remove(false);
					}
				}
				catch (iex) {
					Debug.log("Couldn't remove old broken queue file", iex);
				}
				let broken = __db.clone();
				broken.moveTo(null, DB_FILE_BROKEN);
				_connection = Storage.openDatabase(__db);
			}
		}

		try {
			if (('schemaVersion' in _connection) && _connection.schemaVersion != DB_VERSION) {
				/*
					migrate data
				*/
				_connection.schemaVersion = DB_VERSION;
				Debug.log("setting schema version");
			}
			if (!_connection.tableExists('queue')) {
				_connection.executeSimpleSQL('PRAGMA page_size = 4096');
				_connection.createTable('queue', 'uuid INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER, item TEXT');
			}
		}
		catch (ex) {
			Debug.log("failed to create table", ex);
			// no-op
		}
		try {
			if (!pb) {
				_connection.executeSimpleSQL("PRAGMA journal_mode = MEMORY");
			}
			_connection.executeSimpleSQL("PRAGMA synchronous = NORMAL");
		}
		catch (ex) {
			Debug.log("SQLite", _connection.lastErrorString);
		}
		Debug.log("QueueStore: done initialzing");
	},
	shutdown: function() {
		if (!this._initialized) {
			return;
		}

		// give manager a chance to save running
		Observers.notifyObservers(null, 'DTA:shutdownQueueStore', null);

		this._initialized = false;
		// finish any pending operations
		if (_timer) {
			try {
				_timer.cancel();
			}
			catch (ex) { /* don't care */ }

			_timer = null;
			this._saveDownloadQueue();
		}
		try {
			_connection.executeSimpleSQL('VACUUM');
		}
		catch (ex) {
			// no-op
		}
		try {
			_connection.close();
			_connection = null;
		}
		catch (ex) {
			Debug.log("Cannot close!", ex);
		}
		Debug.log("QueueStore: shutdown complete!");
	},
	reinit: function(pb) {
		this.shutdown();
		this.init(pb);
	},
	clear: function() {
		this.shutdown();
		try {
			if (__db.exists()) {
				__db.remove(false);
			}
		}
		catch (ex) {
			Debug.log("QueueStore: Cannot remove DB", ex);
		}
		this.init(this._private);
		Observers.notifyObservers(null, 'DTA:clearedQueueStore', null);
	},
	enterPrivateBrowsing: function() {
		Debug.log("QueueManager: entering pbm");
		this.reinit(true);
	},
	exitPrivateBrowsing: function() {
		Debug.log("QueueManager: exiting pbm");
		this.reinit(false);
	},
	beginUpdate: function() {
		if (_connection.transactionInProgress) {
			Debug.log("Transaction already in progress; FIXME");
			return;
		}
		_connection.beginTransactionAs(_connection.TRANSACTION_DEFERRED);
	},
	endUpdate: function() {
		if (!_connection.transactionInProgress) {
			return;
		}
		_connection.commitTransaction();
	},
	backup: function() {
		if (!('backupDB' in _connection)) {
			Debug.log("DB Backup not possible");
			return;
		}
		try {
			if (!_connection.backupDB(DB_FILE_BAK).exists()) {
				throw new Exception("DB Backup failed!");
			}
		}
		catch (ex) {
			Debug.log("QueueStore: Cannot backup queue", ex);
		}
	},
	addDownload: function(download, position) {
		if (!download) {
			throw new Exception("You must provide a Download to save!");
		}
		let stmt = _connection.createStatement('INSERT INTO queue (pos, item) VALUES (:position, :item)');
		stmt.params.position = position;
		stmt.params.item = download;
		stmt.execute();
		stmt.finalize();
		return _connection.lastInsertRowID;
	},
	saveDownload: function(id, download) {
		if (!download) {
			throw new Exception("You must provide a Download to save!");
		}
		if (!_saveStmt) {
			_saveStmt = _asyncStatement('UPDATE queue SET item = :item WHERE uuid = :uuid');
			_saveStmtParams = _saveStmt.newBindingParamsArray();
		}

		let bp = _saveStmtParams.newBindingParams();
		bp.bindByName("item", download);
		bp.bindByName("uuid", id);
		_saveStmtParams.addParams(bp);

		if (!_timer) {
			// delay up to 5000 msecs
			_timer = Timers.createOneshot(5000, this._saveDownloadQueue, this);
		}
	},
	_saveDownloadQueue: function() {
		if (!_saveStmt) {
			return;
		}
		let stmt = _saveStmt;
		stmt.bindParameters(_saveStmtParams);
		_saveStmt = null;
		_saveStmtParams = null;
		_timer = null;

		stmt.executeAsync();
	},
	asyncSavePosition: function(downloads) {
		if (downloads.length == 0) {
			Debug.log("no position changes");
			return;
		}
		let stmt = _asyncStatement("UPDATE queue SET pos = :pos WHERE uuid = :uuid");
		let params = stmt.newBindingParamsArray();
		for each (let d in downloads) {
			let bp = params.newBindingParams();
			bp.bindByName("pos", d.position);
			bp.bindByName("uuid", d.dbId);
			params.addParams(bp);
		}
		stmt.bindParameters(params);
		stmt.executeAsync();
	},
	deleteDownload: function(id) {
		if (!id) {
			return;
		}
		let stmt = _asyncStatement('DELETE FROM queue WHERE uuid = :uuid');
		stmt.params.uuid = id;
		stmt.executeAsync();
	},

	loadItems: function(callback, ctx) {
		ctx = ctx || null;
		let stmt;
		try {
			stmt = _asyncStatement(STMT_SELECT);
		}
		catch (ex) {
			Debug.log("SQLite", _connection.lastErrorString);
			callback.call(ctx, null);
		}
		let rows = [];
		stmt.executeAsync({
			handleResult: function(aResult) {
				for (let row = aResult.getNextRow(); row; row = aResult.getNextRow()) {
					rows.push({
						id: row.getResultByIndex(0),
						serial: row.getResultByIndex(1)
						});
				}
			},
			handleError: function(aError) {
				Debug.log('failed load queue file', aError);
				callback.call(ctx, null);
			},
			handleCompletion: function(aReason) {
				stmt.finalize();
				let count = rows.length;
				rows.forEach(function(e) e.count = count);
				Debug.log("All your callback are belong to us");
				callback.call(ctx, rows);
			}
		});
	},
	getQueueSeq: function() {
		let stmt = _connection.createStatement("SELECT seq FROM SQLITE_SEQUENCE WHERE name LIKE '%queue%'");
		let rv = 0;
		if (stmt.executeStep()) {
			rv = stmt.getInt64(0);
		}
		stmt.finalize();
		stmt = null;
		return rv.toString();
	}
};

const SHUTDOWN_TOPIC = 'profile-change-teardown';

var ShutdownObserver = {
	install: function() {
		Observers.addObserver(this, SHUTDOWN_TOPIC, false);
	},
	uninstall: function() {
		Observers.removeObserver(this, SHUTDOWN_TOPIC);
		pbm.unregisterCallbacks(QueueStore);
	},
	observe: function(subject, topic, data) {
		if (topic == SHUTDOWN_TOPIC) {
			this.uninstall();
			try {
				QueueStore.shutdown();
			}
			catch (ex) {
				Debug.log("Failed to shutdown QueueStore", ex);
			}
		}
	}
};

pbm.registerCallbacks(QueueStore);
QueueStore.init();
ShutdownObserver.install();
