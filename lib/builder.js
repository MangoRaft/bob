var util = require('util');
var fs = require('fs');
var net = require('net');
var path = require('path');
var events = require('events');
var os = require('os');
var tar = require('tar-fs');
var Minio = require('minio');
var mkdirp = require('mkdirp');

var Builder = function(options) {
	events.EventEmitter.call(this);

	this.options = options;

	this.docker = options.docker;

	this.registry = options.registry || 'cdn-registry-1.docker.io';
	this.auth = options.auth;
	this.user = options.user;
	this.name = options.name;
	this.tag = options.tag;
	this.folder = options.folder;
	this.tar = options.tar;
	this.s3 = options.s3 || false;
	this.raw = options.raw || false;
	this.buildpack = options.buildpack || 'mangoraft/buildpack';
	this.repo = this.registry + '/' + this.user + '/' + this.name;
	this.commands = null;
	this.commit = null;
	this.size = 0;
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
						repo : self.repo,
						commands : self.commands,
						size : self.size
					};
					if (!self.commands && !self.raw) {
						self.emit('error', new Error('No Procfile found.'));
					} else {
						self.emit('build', info);
					}
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

	if (self.raw) {
		return self.emit('_dockerFile');
	}

	var dockerFile = 'FROM ' + this.buildpack + '\n';
	dockerFile += 'ADD . /app\n';
	dockerFile += 'ENV PORT 8080\n';
	dockerFile += 'WORKDIR /app\n';
	dockerFile += 'expose 8080\n';
	dockerFile += 'RUN herokuish buildpack build\n';
	fs.writeFile(path.join(this.folder, 'Dockerfile'), dockerFile, function(err) {
		if (err)
			throw err;
		self.emit('_dockerFile');
	});
};

Builder.prototype.mkdir = function(dir, cb) {
	var self = this;
	fs.exists(dir, function(exists) {
		if (exists)
			return cb();
		mkdirp(dir, cb);
	});
};

Builder.prototype._buildImage = function() {
	var self = this;
	var tarDir = path.join(this.tar, this.user);
	var tarName = self.name + '.' + self.tag + '.tar';
	var tarFile = path.join(tarDir, tarName);
	this.mkdir(tarDir, function(err) {
		if (err) {
			return self.emit('error', err);
		}

		var tarStram = tar.pack(self.folder, {
			ignore : function(name) {
				return name.indexOf('.git') != -1;
			}
		});

		var writeStream = fs.createWriteStream(tarFile);

		tarStram.pipe(writeStream);

		if (self.s3) {
			var minioClient = new Minio(self.s3);
			writeStream.once('close', function() {
				minioClient.makeBucket('tar', 'us-east-1', function(err) {
					minioClient.fPutObject('tar', self.user + '/' + self.name + '/' + tarName, tarFile, 'application/octet-stream', function(err, etag) {

					});
				});
			});
		}

		self.docker.buildImage(tarStram, {
			t : self.registry + '/' + self.user + '/' + self.name + ':' + self.tag,
			q : false
		}, function(err, stream) {
			if (err)
				throw err;
			function onEnd() {
				if (!self.commands && !self.raw) {
					self.emit('error', new Error('No Procfile found.'));
				} else {
					self.emit('_buildImage');
				}
			}


			stream.on('end', onEnd);

			stream.on('data', function(data) {
				try {
					var json = JSON.parse(data.toString());

				} catch(err) {
					return console.log(err, data.toString());
				}
				if (json.error) {
					stream.removeListener('end', onEnd);

					self.emit('error', new Error(json.error.message));
					return console.log(json);
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
				if (json.stream.indexOf('Default types for  ->') == 0 && !self.raw) {
					stream.removeListener('end', onEnd);

					stream.end();
					self.emit('error', new Error('No Procfile found.'));

				}
				self.emit('stream', json.stream);
			});

		});

	});

};
Builder.prototype._tag = function() {
	var self = this;
	return self.emit('_tag');
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
	var self = this;
	var image = this.docker.getImage(self.registry + '/' + self.user + '/' + self.name + ':' + self.tag);
	var progress = {
		images : {},
		total : {
			current : 0,
			total : 0
		}
	};

	image.push({
		//tag : this.tag,
		authconfig : self.auth
	}, function(err, data) {
		if (err)
			throw err;
		data.on('data', function(data) {
			var json = JSON.parse(data.toString());

			if (json.error) {
				return console.log(json)
				throw new Error(json.error.message);
			}

			self.emit('push status', json.status);
			if (json.progress)
				self.emit('push progress', json.progress);
			if (json.aux) {
				console.log('push', json.aux)
				self.size = json.aux.Size;
			}
			if (json.progressDetail && json.progressDetail.current) {
				self.emit('push progressDetail', json.progressDetail);
			}
		});
		data.on('end', function(data) {
			self.emit('_push');
		});
	});
};
module.exports = Builder;
