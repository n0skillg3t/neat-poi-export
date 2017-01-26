"use strict";

var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Tools = require("neat-base").Tools;
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
            authModuleName: "auth",
            exportRoute: "/poi-export",
            elementsModuleName: "elements",
            webserverModuleName: "webserver",
            dbModuleName: "database",
            dbModelName: "pitch",
            exportFieldsMap: { // these are required
                gps: "gps", // required because mongoose pitch model has virtuals ( latitude, longitude ) that are referring to this field
                lat: "latitude",
                long: "longitude",
                country: "country",
                city: "city",
                zip: "zip",
                street: "street",
                type: "pitchType",
                name: "_de.name",
                createdAt: "_createdAt"
            },
            optionalFieldsMap: {
                seaLevel: {
                    key: "seaLevel"
                }
            }
        }
    }

    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");

            if (Application.modules[this.config.webserverModuleName] && this.config.exportRoute) {
                Application.modules[this.config.webserverModuleName].addRoute("post", this.config.exportRoute, (req, res, next) => {
                    this.handleRequest(req, res);
                }, 9999);
            }

            return resolve(this);
        });
    }

    handleRequest(req, res) {

        if(!req.body.format || !req.body.query) {
            return res.status(400).end('no format and/or query given');
        }

        try {
            var model = Application.modules[this.config.dbModuleName].getModel(this.config.dbModelName);
        } catch (e) {
            return res.status(400).end('model "' + this.config.dbModelName + '" does not exist');
        }

        if (Application.modules[this.config.authModuleName]) {
            if (!Application.modules[this.config.authModuleName].hasPermission(req, this.config.dbModelName, "find")) {
                return res.status(401).end();
            }
        }

        var format = req.body.format.toLowerCase();
        var query = req.body.query.query || {};
        var limit = req.body.query.limit || 10;
        var page = req.body.query.page || 0;
        var sort = req.body.query.sort || {"_createdAt": -1};

        if(validFormats.indexOf(format) === -1) {
            return res.status(400).end('invalid format "'+ format +'". Valid formats are: ' + validFormats.join(', '));
        }

        ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
        this.config.exportFields = [];

        for(var key in this.config.exportFieldsMap) {
            this.config.exportFields.push(this.config.exportFieldsMap[key]);
        }

        for(var key in this.config.optionalFieldsMap) {
            this.config.exportFields.push(this.config.optionalFieldsMap[key].key);
        }

        var dbQuery = model.find(query, this.config.exportFields.join(" ")).limit(limit).skip(limit * page).sort(sort);

        dbQuery.exec().then((docs) => {

            this.validatePOIs(docs).then((validPOIs) => {

                if(format === "json") {
                    return res.json(validPOIs);
                }

                this.exportPOIs(format, validPOIs, res);

            }, (err) => {
                res.err(err);
            })

        }, (err) => {
            res.err(err);
        });

    }

    validatePOIs(docs) {
        return new Promise((resolve, reject) => {
            var validPOIs = [];

            for(var i = 0; i<docs.length; i++) {
                var POI = docs[i];
                var skip = false;

                var tempObj = {};
                for(var key in this.config.exportFieldsMap) {
                    var field = this.config.exportFieldsMap[key];

                    if(!POI.get(field)) {
                        skip = true;
                        break;
                    } else {
                        tempObj[key] = POI.get(field);
                    }
                }

                if(!skip) {

                    for(var key in this.config.optionalFieldsMap) {
                        var field = this.config.optionalFieldsMap[key];

                        if(POI.get(field.key)) {
                            tempObj[key] = POI.get(field.key);
                        } else {
                            tempObj[key] = (field.default)?field.default:null;
                        }
                    }

                    validPOIs.push(tempObj);
                }
            }

            resolve(validPOIs);
        });
    }

    exportPOIs(format, POIs, res) {

        var fileData = this.getMainFileDataForFormat(format);
        var fileName = "POI-EXPORT_" + moment().format("DD.MM.YYYY");
        var waypoints = "";

        res.setHeader("content-type", contentTypes[format]);
        res.setHeader("Content-Disposition", "attachment;filename="+ fileName + "." + format);

        for(var i = 0; i<POIs.length; i++) {
            waypoints += this.createWaypoint(format,POIs[i]);
        }

        fileData = fileData.replace("{{POIDATA}}",waypoints);
        res.send(fileData);
    }


    getMainFileDataForFormat(format) {
        switch(format) {
            case "gpx":
                return '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>' +
                    '<gpx version="1.1" creator="Neat POI Export"><metadata>' +
                    '<author><name>Neat POI Export</name></author></metadata>' +
                    '{{POIDATA}}' +
                    '</gpx>';
                break;
            case "xml":
                return '<rss version="2.0" xmlns:georss="http://www.georss.org/georss" xmlns:gml="http://www.opengis.net/gml" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
                    '  <channel>\n' +
                    '    <title>Neat POI Export</title>\n' +
                    '{{POIDATA}}' +
                    '  </channel>\n' +
                    '</rss>';
                break;
            case "loc":
                return '<?xml version="1.0" encoding="UTF-8" ?>\n' +
                    '<loc version="1.0" src="Neat POI Export">\n' +
                    '{{POIDATA}}' +
                    '</loc>'
                break;
            case "kml":
                return '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/kml/2.2 http://schemas.opengis.net/kml/2.2.0/ogckml22.xsd">\n' +
                    '<Document>\n' +
                    '<name>Neat POI Export</name>' +
                    '<description><![CDATA[Generated by Neat POI Export - https://www.npmjs.com/package/neat-poi-export]]></description>' +
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

    createWaypoint(format, POI) {

        var waypoint = "";

        switch(format) {
            case "gpx":
                waypoint = '<wpt lat="'+ POI.lat +'" lon="'+ POI.long +'"><name>'+ POI.name +'</name><time>' + POI.createdAt + '</time><sym>RV Park (Outdoors)</sym></wpt>';
                break;
            case "xml":
                waypoint = '    <item>\n      <title>'+ POI.name +'</title>\n      <georss:point>'+ POI.lat +' '+ POI.long +'</georss:point>\n    </item>\n';
                break;
            case "asc":
                waypoint = POI.long + ',' + POI.lat + ',' + '"' + POI.name + '"\n';
                break;
            case "loc":
                waypoint = '<waypoint>' +
                    '<coord lat="'+ POI.lat +'" lon="'+ POI.long +'" />' +
                    '<type>RV Park (Outdoors)</type>' +
                    '<sym>RV Park (Outdoors)</sym>' +
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