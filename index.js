"use strict";

let Application = require("neat-base").Application;
let Module = require("neat-base").Module;
let Promise = require("bluebird");
let fs = require('fs');
let moment = require('moment');

let validFormats = [
    "gpx",
    "asc",
    "kml",
    "loc",
    "xml",
    "csv",
    "json"
];

let requiredFields = [
    "lat",
    "long",
    "name"
];

let contentTypes = {
    gpx: "text/gpx; charset=utf-8",
    xml: "text/xml; charset=utf-8",
    asc: "text/asc; charset=utf-8",
    loc: "text/loc; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    kml: "text/kml; charset=utf-8",
    json: "application/json; charset=utf-8"
};

let exportRunning = false;

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

        let model, reqQuery;

        if(exportRunning) {
            return res.status(503).end('Busy exporting. Please try again in a couple of minutes.');
        }

        if(!req.query.format || !req.query.query) {
            return res.status(400).end('no format and/or query given');
        }

        try {
            model = Application.modules[this.config.dbModuleName].getModel(this.config.dbModelName);
        } catch (e) {
            return res.status(400).end('model "' + this.config.dbModelName + '" does not exist');
        }

        try {
            reqQuery = JSON.parse(decodeURIComponent(req.query.query));
        } catch (e) {
            return res.status(400).end('failed to parse json');
        }

        if (Application.modules[this.config.authModuleName]) {
            if (!Application.modules[this.config.authModuleName].hasPermission(req, this.config.dbModelName, "find")) {
                return res.status(401).end('access denied');
            }
        }

        let format = req.query.format.toLowerCase();
        let customIcon = {};

        if(req.query.customicon) {
            try {
                customIcon = JSON.parse(decodeURIComponent(req.query.customicon));
            } catch(e) {
                return res.status(400).end('failed to parse json');
            }
        }

        let query = reqQuery.query || {};
        let sort = reqQuery.sort || {"_createdAt": -1};
        let projection = reqQuery.projection || null;

        if(validFormats.indexOf(format) === -1) {
            return res.status(400).end('invalid format "'+ format +'". Valid formats are: ' + validFormats.join(', '));
        }

        ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
        let fileName = "POI-EXPORT_" + moment().format("DD.MM.YYYY");

        res.setHeader("content-type", contentTypes[format]);
        res.setHeader("Content-Disposition", "attachment;filename="+ fileName + "." + format);


        res.write(this.getFileHeader(format,customIcon));

        let result = [];
        let exportPage = 0;
        let self = this;
        let exportlimit = 100;

        function nextPage() {

            if(req.connectionAborted) {
                console.log("Connection aborted.");
                exportRunning = false;
                return Promise.resolve(result);
            } else if(!exportRunning) {
                console.log("Export started.");
                exportRunning = true;
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
                        res.write(self.createWaypoint(format,validPOIs[i],customIcon));
                    }

                    if(results.length < exportlimit) {
                        console.log("Export finished with page " + exportPage);
                        return Promise.resolve(result);
                    }

                    console.log("EXPORTED PAGE " + exportPage);
                    exportPage++;
                    return nextPage();
                });
            });
        }

        nextPage().then(() => {
            exportRunning = false;

            res.write(this.getFileFooter(format));
            res.end();
        }, (err) => {
            exportRunning = false;

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


    getFileHeader(format, customIcon) {
        switch(format) {
            case "gpx":
                return '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n' +
                    '<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="POI Export" version="1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n' +
                    '   <metadata>\n'+
                    '       <author>\n' +
                    '           <name>POI Export</name>\n' +
                    '       </author>\n' +
                    '   </metadata>\n';
                break;
            case "xml":
                return '<rss version="2.0" xmlns:georss="http://www.georss.org/georss" xmlns:gml="http://www.opengis.net/gml" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
                    '   <channel>\n' +
                    '       <title>POI Export</title>\n';
                break;
            case "loc":
                return '<?xml version="1.0" encoding="UTF-8" ?>\n' +
                    '<loc version="1.0" src="POI Export">\n';
                break;
            case "kml":
                return '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/kml/2.2 http://schemas.opengis.net/kml/2.2.0/ogckml22.xsd">\n' +
                    '   <Document>\n' +
                    '       <name>POI Export</name>\n' +
                    '       <description>POI Export</description>\n' +
                    ''+ ((customIcon.kml)?('       <Style id="kmlCustomIcon">\n          <IconStyle>\n              <Icon>\n               <href>' + customIcon.kml + '</href>\n              </Icon>\n          </IconStyle>\n       </Style>'):'');
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
                return '</gpx>';
                break;
            case "xml":
                return '    </channel>\n' +
                    '</rss>';
                break;
            case "loc":
                return '</loc>';
                break;
            case "kml":
                return '    </Document>' +
                    '</kml>';
                break;
            default:
                return '';
        }
    }

    createWaypoint(format, POI, customIcon) {

        var waypoint = "";

        switch(format) {
            case "gpx":
                waypoint = '    <wpt lat="'+ POI.lat +'" lon="'+ POI.long +'">\n' +
                    '       <name>'+ POI.name +'</name>\n' +
                    ''+ ((POI.description)?('       <desc>'+ POI.description +'</desc>\n'):'') +
                    ''+ ((POI.type)?('      <type>'+ POI.type +'</type>\n'):'') +
                    '       <ele>'+ (POI.seaLevel?POI.seaLevel:"0.0000000") +'</ele>\n' +
                    '       <time>' + (new Date(POI.createdAt).toISOString()) + '</time>\n' +
                    '       <sym>'+ ((POI.symbol)?POI.symbol:'0') +'</sym>\n' +
                    ''+ ((customIcon.gpx)?('      <link href="'+ customIcon.gpx +'"/>\n'):'') +
                    '   </wpt>\n';
                break;
            case "xml":
                waypoint = '        <item>\n' +
                    ''+ ((POI.createdAt)?('            <pubDate>'+ (new Date(POI.createdAt).toISOString()) +'</pubDate>\n'):'') +
                    '            <title>'+ POI.name +'</title>\n' +
                    ((POI.description)?('            <description>'+ POI.description +'</description>\n'):'') +
                    '            <georss:point>'+ POI.lat +' '+ POI.long +'</georss:point>\n' +
                    '        </item>\n';
                break;
            case "asc":
                waypoint = POI.long + ',' + POI.lat + ',' + '"' + POI.name + '"\n';
                break;
            case "loc":
                waypoint = '    <waypoint>\n' +
                    '        <coord lat="'+ POI.lat +'" lon="'+ POI.long +'" />\n' +
                    ((POI.type)?('        <type>'+ POI.type +'</type>\n'):'') +
                    '        <sym>'+ ((POI.symbol)?POI.symbol:'0') +'</sym>\n' +
                    '        <ele>'+ (POI.seaLevel?POI.seaLevel:"0.0000000") +'</ele>\n' +
                    '        <name id="'+ POI.name +'">'+ POI.name +'</name>\n' +
                    '    </waypoint>\n';
                break;
            case "kml":
                waypoint = '            <Placemark>\n' +
                    '                <name>'+ POI.name +'</name>\n' +
                    ((customIcon.kml)?('                <styleUrl>#kmlCustomIcon</styleUrl>\n'):'') +
                    '                <Point>\n' +
                    '                    <coordinates>'+ POI.long + ',' + POI.lat + ',' + (POI.seaLevel?POI.seaLevel:"0.0000000") +'</coordinates>\n' +
                    '                </Point>\n' +
                    '            </Placemark>\n';
                break;
            case "csv":
                waypoint = POI.lat + ',' + POI.long + ',' + (POI.seaLevel?POI.seaLevel:"0.0") +'\n';
                break;
        }
        return waypoint;
    }
};