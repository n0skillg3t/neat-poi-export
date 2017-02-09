"use strict";

var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Promise = require("bluebird");
var fs = require('fs');
var moment = require('moment');

var validFormats = [
    "gpx",
    "asc",
    "kml",
    "loc",
    // TODO: "wpt",
    "xml",
    "csv",
    "json"
];


var requiredFields = [
    "lat",
    "long",
    "name"
];


var contentTypes = {
    gpx: "text/gpx; charset=utf-8",
    xml: "text/xml; charset=utf-8",
    asc: "text/asc; charset=utf-8",
    loc: "text/loc; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    kml: "text/kml; charset=utf-8",
    json: "application/json; charset=utf-8"
};

module.exports = class PoiExport extends Module {

    static defaultConfig() {
        return {
            projectionModuleName: "projection",
            authModuleName: "auth",
            exportRoute: "/poi-export",
            elementsModuleName: "elements",
            webserverModuleName: "webserver",
            dbModuleName: "database",
            dbModelName: "pitch"
        }
    }

    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");

            if (Application.modules[this.config.webserverModuleName] && this.config.exportRoute) {
                Application.modules[this.config.webserverModuleName].addRoute("get", this.config.exportRoute, (req, res, next) => {

                    req.connectionAborted = false;

                    req.connection.on('close',function() {
                        req.connectionAborted = true;
                    });

                    this.handleRequest(req, res);
                }, 9999);
            }

            return resolve(this);
        });
    }

    handleRequest(req, res) {

        if(!req.query.format || !req.query.query) {
            return res.status(400).end('no format and/or query given');
        }

        try {
            var model = Application.modules[this.config.dbModuleName].getModel(this.config.dbModelName);
        } catch (e) {
            return res.status(400).end('model "' + this.config.dbModelName + '" does not exist');
        }

        try {
            var reqQuery = JSON.parse(decodeURIComponent(req.query.query));
        } catch (e) {
            return res.status(400).end('failed to parse json');
        }

        if (Application.modules[this.config.authModuleName]) {
            if (!Application.modules[this.config.authModuleName].hasPermission(req, this.config.dbModelName, "find")) {
                return res.status(401).end('permission denied');
            }
        }

        var format = req.query.format.toLowerCase();
        var query = reqQuery.query || {};
        var limit = reqQuery.limit || 10;
        var page = reqQuery.page || 0;
        var sort = reqQuery.sort || {"_createdAt": -1};
        var projection = reqQuery.projection || null;

        if(validFormats.indexOf(format) === -1) {
            return res.status(400).end('invalid format "'+ format +'". Valid formats are: ' + validFormats.join(', '));
        }

        ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
        var parts = 1;

        // Prevent server overload
        if(limit > 100) {
            // 8461
            var parts = limit / 100;

            if(parts === +parts && parts !== (parts|0)) {
                parts = parseInt(parts);
                parts++;
            }
        }

        var dbQuerys = [];

        var fileName = "POI-EXPORT_" + moment().format("DD.MM.YYYY");

        res.setHeader("content-type", contentTypes[format]);
        res.setHeader("Content-Disposition", "attachment;filename="+ fileName + "." + format);
        res.write(this.getFileHeader(format));

        let result = [];
        let exportPage = 0;
        let self = this;
        let exportlimit = 100;
        function nextPage() {

            if(req.connectionAborted) {
                console.log("Connection aborted.");
                return Promise.resolve(result);
            }

            console.log("STARTING " + exportPage);

            let queryExecution = model.find(query).limit(exportlimit).skip(exportlimit * exportPage).sort(sort);

            if (projection && Application.modules[self.config.projectionModuleName]) {
                queryExecution.projection(projection, req);
            }

            return queryExecution.then((docs) => {
                return Promise.map(docs, function(doc) {
                    return doc;
                });
            }).then((results) => {
                return self.validatePOIs(results).then((validPOIs) => {

                    for(var i = 0; i<validPOIs.length; i++) {
                        res.write(self.createWaypoint(format,validPOIs[i]));
                    }

                    if(results.length < exportlimit) {
                        console.log("EXPORTED LAST PAGE " + exportPage);
                        return Promise.resolve(result);
                    }

                    console.log("EXPORTED PAGE " + exportPage);
                    exportPage++;
                    return nextPage();
                });
            });
        }

        nextPage().then((result) => {
            res.write(this.getFileFooter(format));
            res.end();
        }, (err) => {

            console.log(err);
            res.status(500);
            res.end();
        });
    }

    validatePOIs(docs) {
        return new Promise((resolve, reject) => {
            var validPOIs = [];

            for(var i = 0; i<docs.length; i++) {
                var POI = docs[i];
                var skip = false;

                for(var x = 0; x<requiredFields.length; x++) {
                    if(!POI[requiredFields[x]]) {
                        skip = true;
                        break;
                    }
                }

                if(!skip) {
                    validPOIs.push(POI);
                }
            }

            resolve(validPOIs);
        });
    }


    getMainFileDataForFormat(format) {
        switch(format) {
            case "gpx":
                return '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>' +
                    '<gpx version="1.1" creator="POI Export"><metadata>' +
                    '<author><name>POI Export</name></author></metadata>' +
                    '{{POIDATA}}' +
                    '</gpx>';
                break;
            case "xml":
                return '<rss version="2.0" xmlns:georss="http://www.georss.org/georss" xmlns:gml="http://www.opengis.net/gml" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
                    '  <channel>\n' +
                    '    <title>POI Export</title>\n' +
                    '{{POIDATA}}' +
                    '  </channel>\n' +
                    '</rss>';
                break;
            case "loc":
                return '<?xml version="1.0" encoding="UTF-8" ?>\n' +
                    '<loc version="1.0" src="POI Export">\n' +
                    '{{POIDATA}}' +
                    '</loc>'
                break;
            case "kml":
                return '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/kml/2.2 http://schemas.opengis.net/kml/2.2.0/ogckml22.xsd">\n' +
                    '<Document>\n' +
                    '<name>POI Export</name>' +
                    '<description>Default POI Export</description>' +
                    '{{POIDATA}}' +
                    '</Document>' +
                    '</kml>';
                break;
            case "csv":
                return 'Latitude,Longitude,Elevation\n{{POIDATA}}';
            default:
                return '{{POIDATA}}';
        }
    }


    getFileHeader(format) {
        switch(format) {
            case "gpx":
                return '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>' +
                    '<gpx version="1.1" creator="POI Export"><metadata>' +
                    '<author><name>POI Export</name></author></metadata>\n';
                break;
            case "xml":
                return '<rss version="2.0" xmlns:georss="http://www.georss.org/georss" xmlns:gml="http://www.opengis.net/gml" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
                    '  <channel>\n' +
                    '    <title>POI Export</title>\n';
                break;
            case "loc":
                return '<?xml version="1.0" encoding="UTF-8" ?>\n' +
                    '<loc version="1.0" src="POI Export">\n';
                break;
            case "kml":
                return '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/kml/2.2 http://schemas.opengis.net/kml/2.2.0/ogckml22.xsd">\n' +
                    '<Document>\n' +
                    '<name>POI Export</name>' +
                    '<description>Default POI Export</description>\n';
                break;
            case "csv":
                return 'Latitude,Longitude,Elevation\n';
            default:
                return '';
        }
    }

    getFileFooter(format) {
        switch(format) {
            case "gpx":
                return '\n</gpx>';
                break;
            case "xml":
                return '\n  </channel>\n' +
                    '</rss>';
                break;
            case "loc":
                return '\n</loc>';
                break;
            case "kml":
                return '\n</Document>' +
                    '</kml>';
                break;
            default:
                return '';
        }
    }

    createWaypoint(format, POI) {

        var waypoint = "";

        switch(format) {
            case "gpx":
                waypoint = '<wpt lat="'+ POI.lat +'" lon="'+ POI.long +'"><name>'+ POI.name +'</name>'+ ((POI.description)?('<desc>'+ POI.description +'</desc>'):'') +''+ ((POI.type)?('<type>'+ POI.type +'</type>'):'') +'<ele>'+ (POI.seaLevel?POI.seaLevel:"0.0000000") +'</ele><time>' + (new Date(POI.createdAt).toISOString()) + '</time><sym>'+ ((POI.symbol)?POI.symbol:'0') +'</sym></wpt>';
                break;
            case "xml":
                waypoint = '    <item>\n      '+ ((POI.createdAt)?('<pubDate>'+ (new Date(POI.createdAt).toISOString()) +'</pubDate>\n      '):'') +'<title>'+ POI.name +'</title>\n      '+ ((POI.description)?('<description>'+ POI.description +'</description>\n      '):'') +'<georss:point>'+ POI.lat +' '+ POI.long +'</georss:point>\n    </item>\n';
                break;
            case "asc":
                waypoint = POI.long + ',' + POI.lat + ',' + '"' + POI.name + '"\n';
                break;
            case "loc":
                waypoint = '<waypoint>' +
                    '<coord lat="'+ POI.lat +'" lon="'+ POI.long +'" />' +
                    ((POI.type)?('<type>'+ POI.type +'</type>'):'') +
                    '<sym>'+ ((POI.symbol)?POI.symbol:'0') +'</sym>' +
                    '<ele>'+ (POI.seaLevel?POI.seaLevel:"0.0000000") +'</ele>' +
                    '<name id="'+ POI.name +'">'+ POI.name +'</name>' +
                    '</waypoint>';
                break;
            case "kml":
                waypoint = '<Placemark>' +
                    '<name>'+ POI.name +'</name>' +
                    '<Point>' +
                    '<coordinates>'+ POI.long + ',' + POI.lat + ',' + (POI.seaLevel?POI.seaLevel:"0.0000000") +'</coordinates>' +
                    '</Point>' +
                    '</Placemark>'
                break;
            case "csv":
                waypoint = POI.lat + ',' + POI.long + ',' + (POI.seaLevel?POI.seaLevel:"0.0") +'\n';
                break;
        }

        return waypoint;
    }
};