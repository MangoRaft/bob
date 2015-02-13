var util = require('util');
var fs = require('fs');
var net = require('net');
var path = require('path');
var events = require('events');
var os = require('os');
var tar = require('tar-fs');

var Builder = function(options) {
	events.EventEmitter.call(this);

	this.options = options;

	this.docker = options.docker;

	this.registry = options.registry || 'cdn-registry-1.docker.io';
	this.user = options.user;
	this.name = options.name;
	this.tag = options.tag;
	this.folder = options.folder;
	this.buildpack = options.buildpack || 'mangoraft/buildpack';
	this.repo = this.registry + '/' + this.user + '/' + this.name;
	this.commands = null;
	this.commit = null;
	this.proc = [];
};
//
// Inherit from `events.EventEmitter`.
//
util.inherits(Builder, events.EventEmitter);
Builder.prototype.build = function() {
	var self = this;
	this.once('_dockerFile', function() {
		self.once('_buildImage', function() {
			self.once('_tag', function() {
				self.once('_push', function() {
					var info = {
						image : self.repo + ':' + self.tag,
						registry : self.registry,
						user : self.user,
						name : self.name,
						tag : self.tag,
						folder : self.folder,
						buildpack : self.buildpack,
						repo : self.repo
					};

					self.emit('build', info);
				});
				self._push();
			});
			self._tag();
		});
		self._buildImage();
	});
	self._dockerFile();
};
Builder.prototype._dockerFile = function() {
	var self = this;
	var dockerFile = 'FROM ' + this.buildpack + '\n';
	dockerFile += 'ADD . /app\n';
	dockerFile += 'RUN herokuish buildpack build\n';
	dockerFile += 'ENV PORT 8080\n';
	dockerFile += 'WORKDIR /app\n';
	dockerFile += 'expose 8080\n';
	fs.writeFile(path.join(this.folder, 'Dockerfile'), dockerFile, function(err) {
		if (err)
			throw err;
		self.emit('_dockerFile');
	});
};
Builder.prototype._buildImage = function() {
	var self = this;
	this.docker.buildImage(tar.pack(this.folder), {
		t : this.name,
		q : false
	}, function(err, stream) {
		if (err)
			throw err;
		stream.on('data', function(data) {
			var json = JSON.parse(data.toString());

			if (json.error) {
				throw new Error(json.error.message);
			}

			if (!json.stream)
				return;

			if (json.stream.indexOf('-----> ') != -1 || json.stream.indexOf('       ') != -1) {
				self.emit('compile', json.stream.replace('\n', '').replace('\u001b[1G', '').replace('       \u001b[1G', ''));
			}
			if (json.stream.indexOf('Successfully built ') == 0) {
				self.commit = json.stream.split('Successfully built ')[1].replace('\n', '');
				self.emit('commit', self.commit);
			}
			if (json.stream.indexOf('Step') == 0) {
				self.emit('step', json.stream.replace('\n', '').replace('\u001b[1G', ''));
			}
			if (json.stream.indexOf('Procfile declares types ->') != -1) {
				var commands = json.stream.split('Procfile declares types ->')[1].replace('\n', '').trim().split(', ');
				self.commands = commands.map(function(type) {
					return {
						type : type,
						cmd : 'herokuish procfile start ' + type
					};
				});
				self.emit('commands', self.commands);
			}
		});
		stream.on('end', function() {
			self.emit('_buildImage');
		});
	});
};
Builder.prototype._tag = function() {
	var self = this;

	var image = this.docker.getImage(this.commit);
	image.tag({
		repo : this.repo,
		tag : this.tag
	}, function(err, data) {
		if (err)
			throw err;
		self.emit('_tag');
	});
};
Builder.prototype._push = function() {
	var image = this.docker.getImage(this.repo);
	var self = this;
	image.push({
		tag : this.tag
	}, function(err, data) {
		if (err)
			throw err;
		data.on('data', function(data) {
			var json = JSON.parse(data.toString());

			if (json.error) {
				throw new Error(json.error.message);
			}

			self.emit('push status', json.status);
			if (json.progress)
				self.emit('push progress', json.progress);
			if (json.progressDetail && json.progressDetail.current)
				self.emit('push progressDetail', json.progressDetail);
		});
		data.on('end', function(data) {
			self.emit('_push');
		});
	});
};
module.exports = Builder;
