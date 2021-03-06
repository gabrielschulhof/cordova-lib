/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

/* jshint node:true, bitwise:true, undef:true, trailing:true, quotmark:true,
          indent:4, unused:vars, latedef:nofunc
*/

// The URL:true below prevents jshint error "Redefinition or 'URL'."
/* globals URL:true */

var path          = require('path'),
    _             = require('underscore'),
    fs            = require('fs'),
    shell         = require('shelljs'),
    platforms     = require('./platforms'),
    npmconf       = require('npmconf'),
    events        = require('../events'),
    request       = require('request'),
    config        = require('./config'),
    hooker        = require('./hooker'),
    zlib          = require('zlib'),
    tar           = require('tar'),
    URL           = require('url'),
    Q             = require('q'),
    npm           = require('npm'),
    util          = require('./util'),
    stubplatform  = {
        url    : undefined,
        version: undefined,
        altplatform: undefined,
        subdirectory: ''
    };

exports.cordova = cordova;
exports.cordova_git = cordova_git;
exports.cordova_npm = cordova_npm;
exports.npm_cache_add = npm_cache_add;
exports.custom = custom;
exports.based_on_config = based_on_config;

function Platform(platformString) {
    if (platformString.indexOf('@') != -1) {
        var parts = platformString.split('@');
        this.name = parts[0];
        this.version = parts[1];
    } else {
        this.name = platformString;
        if (platforms[this.name]) this.version = platforms[this.name].version;
    }
}

// Returns a promise for the path to the lazy-loaded directory.
function based_on_config(project_root, platform, opts) {
    var custom_path = config.has_custom_path(project_root, platform);
    if (custom_path === false && platform === 'windows') {
        custom_path = config.has_custom_path(project_root, 'windows8');
    }
    if (custom_path) {
        var dot_file = config.read(project_root),
            mixed_platforms = _.extend({}, platforms);
        mixed_platforms[platform] = _.extend({}, mixed_platforms[platform], dot_file.lib && dot_file.lib[platform] || {});
        return module.exports.custom(mixed_platforms, platform);
    } else {
        return module.exports.cordova(platform, opts);
    }
}

// Returns a promise for the path to the lazy-loaded directory.
function cordova(platform, opts) {
    platform = new Platform(platform);
    var use_git = opts && opts.usegit || platform.name === 'www';
    if ( use_git ) {
        return module.exports.cordova_git(platform);
    } else {
        return module.exports.cordova_npm(platform);
    }
}

function cordova_git(platform) {
    var mixed_platforms = _.extend({}, platforms),
        plat;
    if (!(platform.name in platforms)) {
        return Q.reject(new Error('Cordova library "' + platform.name + '" not recognized.'));
    }
    plat = mixed_platforms[platform.name];
    if (/^...*:/.test(plat.url)) {
        plat.url = plat.url + ';a=snapshot;h=' + platform.version + ';sf=tgz';
    }
    plat.id = 'cordova';
    plat.version = platform.version;
    return module.exports.custom(mixed_platforms, platform.name);
}

function cordova_npm(platform) {
    if ( !(platform.name in platforms) ) {
        return Q.reject(new Error('Cordova library "' + platform.name + '" not recognized.'));
    }
    // Check if this version was already downloaded from git, if yes, use that copy.
    // TODO: remove this once we fully switch to npm workflow.
    var platdir = platforms[platform.name].altplatform || platform.name;
    var git_dload_dir = path.join(util.libDirectory, platdir, 'cordova', platform.version);
    if (fs.existsSync(git_dload_dir)) {
        var subdir = platforms[platform.name].subdirectory;
        if (subdir) {
            git_dload_dir = path.join(git_dload_dir, subdir);
        }
        events.emit('verbose', 'Platform files for "' + platform.name + '" previously downloaded not from npm. Using that copy.');
        return Q(git_dload_dir);
    }

    var pkg = 'cordova-' + platform.name + '@' + platform.version;
    return exports.npm_cache_add(pkg);
}

// Equivalent to a command like
// npm cache add cordova-android@3.5.0
// Returns a promise that resolves to directory containing the package.
function npm_cache_add(pkg) {
    var npm_cache_dir = path.join(util.libDirectory, 'npm_cache');
    // 'cache-min' is the time in seconds npm considers the files fresh and
    // does not ask the registry if it got a fresher version.
    return Q.nfcall( npm.load, { 'cache-min': 3600*24, cache: npm_cache_dir })
    .then(function() {
        return Q.ninvoke(npm.commands, 'cache', ['add', pkg]);
    }).then(function(info) {
        var pkgDir = path.resolve(npm.cache, info.name, info.version, 'package');
        return pkgDir;
    });
}

// Returns a promise for the path to the lazy-loaded directory.
function custom(platforms, platform) {
    var plat;
    var id;
    var uri;
    var url;
    var version;
    var subdir;
    var platdir;
    var download_dir;
    var tmp_dir;
    var lib_dir;
    var isUri;
    if (!(platform in platforms)) {
        return Q.reject(new Error('Cordova library "' + platform + '" not recognized.'));
    }

    plat = _.extend({}, stubplatform, platforms[platform]);
    version = plat.version;
    // Older tools can still provide uri (as opposed to url) as part of extra
    // config to create, it should override the default url provided in
    // platfroms.js
    url = plat.uri || plat.url;
    id = plat.id;
    subdir = plat.subdirectory;
    platdir = plat.altplatform || platform;
    // Return early for already-cached remote URL, or for local URLs.
    uri = URL.parse(url);
    isUri = uri.protocol && uri.protocol[1] != ':'; // second part of conditional is for awesome windows support. fuuu windows
    if (isUri) {
        download_dir = path.join(util.libDirectory, platdir, id, version);
        lib_dir = path.join(download_dir, subdir);
        if (fs.existsSync(download_dir)) {
            events.emit('verbose', id + ' library for "' + platform + '" already exists. No need to download. Continuing.');
            return Q(lib_dir);
        }
    } else {
        // Local path.
        lib_dir = path.join(url, subdir);
        return Q(lib_dir);
    }
    return hooker.fire('before_library_download', {
        platform:platform,
        url:url,
        id:id,
        version:version
    }).then(function() {
        var uri = URL.parse(url);
        var d = Q.defer();
        npmconf.load(function(err, conf) {
            // Check if NPM proxy settings are set. If so, include them in the request() call.
            var proxy;
            if (uri.protocol == 'https:') {
                proxy = conf.get('https-proxy');
            } else if (uri.protocol == 'http:') {
                proxy = conf.get('proxy');
            }
            var strictSSL = conf.get('strict-ssl');

            // Create a tmp dir. Using /tmp is a problem because it's often on a different partition and sehll.mv()
            // fails in this case with "EXDEV, cross-device link not permitted".
            var tmp_subidr = 'tmp_' + id + '_' + process.pid + '_' + (new Date()).valueOf();
            tmp_dir = path.join(util.libDirectory, 'tmp', tmp_subidr);
            shell.rm('-rf', tmp_dir);
            shell.mkdir('-p', tmp_dir);

            var size = 0;
            var request_options = {url:url};
            if (proxy) {
                request_options.proxy = proxy;
            }
            if (typeof strictSSL == 'boolean') {
                request_options.strictSSL = strictSSL;
            }
            events.emit('verbose', 'Requesting ' + JSON.stringify(request_options) + '...');
            events.emit('log', 'Downloading ' + id + ' library for ' + platform + '...');
            var req = request.get(request_options, function(err, res, body) {
                if (err) {
                    shell.rm('-rf', tmp_dir);
                    d.reject(err);
                } else if (res.statusCode != 200) {
                    shell.rm('-rf', tmp_dir);
                    d.reject(new Error('HTTP error ' + res.statusCode + ' retrieving version ' + version + ' of ' + id + ' for ' + platform));
                } else {
                    size = body.length;
                }
            });
            req.pipe(zlib.createUnzip())
            .pipe(tar.Extract({path:tmp_dir}))
            .on('error', function(err) {
                shell.rm('-rf', tmp_dir);
                d.reject(err);
            })
            .on('end', function() {
                events.emit('verbose', 'Downloaded, unzipped and extracted ' + size + ' byte response.');
                events.emit('log', 'Download complete');
                var entries = fs.readdirSync(tmp_dir);
                var entry = path.join(tmp_dir, entries[0]);
                shell.mkdir('-p', download_dir);
                shell.mv('-f', path.join(entry, '*'), download_dir);
                shell.rm('-rf', tmp_dir);
                d.resolve(hooker.fire('after_library_download', {
                    platform:platform,
                    url:url,
                    id:id,
                    version:version,
                    path: lib_dir,
                    size:size,
                    symlink:false
                }));
            });
        });
        return d.promise.then(function () { return lib_dir; });
    });
}


