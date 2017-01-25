"use strict";

var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Tools = require("neat-base").Tools;
var Promise = require("bluebird");
var fs = require('fs');

module.exports = class PoiExport extends Module {

    static defaultConfig() {
        return {}
    }

    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");

            if (Application.modules[this.config.webserverModuleName]) {
                Application.modules[this.config.webserverModuleName].addRoute("post", "/poi-export", (req, res, next) => {
                    this.handleRequest(req, res);
                }, 9999);
            }

            return resolve(this);
        });
    }

    handleRequest(req, res) {

        if(!req.body.format || !req.body.query) {
            return res.end('No format or query given.');
        }


    }

};
