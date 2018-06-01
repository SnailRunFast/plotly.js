/**
* Copyright 2012-2018, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/

'use strict';

var tube2mesh = require('gl-streamtube3d');
var createTubeMesh = tube2mesh.createTubeMesh;

var Lib = require('../../lib');
var parseColorScale = require('../../lib/gl_format_color').parseColorScale;
var zip3 = require('../../lib/zip3');

var axisName2scaleIndex = {xaxis: 0, yaxis: 1, zaxis: 2};

function Streamtube(scene, uid) {
    this.scene = scene;
    this.uid = uid;
    this.mesh = null;
    this.data = null;
}

var proto = Streamtube.prototype;

proto.handlePick = function(selection) {
    var sceneLayout = this.scene.fullSceneLayout;
    var dataScale = this.scene.dataScale;

    function fromDataScale(v, axisName) {
        var ax = sceneLayout[axisName];
        var scale = dataScale[axisName2scaleIndex[axisName]];
        return ax.l2c(v) / scale;
    }

    if(selection.object === this.mesh) {
        var pos = selection.data.position;
        var vel = selection.data.velocity;

        var uu = fromDataScale(vel[0], 'xaxis');
        var vv = fromDataScale(vel[1], 'yaxis');
        var ww = fromDataScale(vel[2], 'zaxis')

        selection.traceCoordinate = [
            fromDataScale(pos[0], 'xaxis'),
            fromDataScale(pos[1], 'yaxis'),
            fromDataScale(pos[2], 'zaxis'),

            uu, vv, ww,
            Math.sqrt(uu * uu + vv * vv + ww * ww)
        ];

        return true;
    }
};

function distinctVals(col) {
    return Lib.distinctVals(col).vals;
}

function getBoundPads(vec) {
    var len = vec.length;
    if(len === 1) {
        return [0.5, 0.5];
    } else {
        return [vec[1] - vec[0], vec[len - 1] - vec[len - 2]];
    }
}

function convert(scene, trace) {
    var sceneLayout = scene.fullSceneLayout;
    var dataScale = scene.dataScale;
    var len = trace._len;
    var tubeOpts = {};

    function toDataCoords(arr, axisName) {
        var ax = sceneLayout[axisName];
        var scale = dataScale[axisName2scaleIndex[axisName]];
        return Lib.simpleMap(arr, function(v) { return ax.d2l(v) * scale; });
    }

    var u = toDataCoords(trace.u.slice(0, len), 'xaxis');
    var v = toDataCoords(trace.v.slice(0, len), 'yaxis');
    var w = toDataCoords(trace.w.slice(0, len), 'zaxis');

    tubeOpts.vectors = zip3(u, v, w);

    var valsx = distinctVals(trace.x.slice(0, len));
    var valsy = distinctVals(trace.y.slice(0, len));
    var valsz = distinctVals(trace.z.slice(0, len));

    // Over-specified mesh case, this would error in tube2mesh
    if(valsx.length * valsy.length * valsz.length > len) {
        return {positions: [], cells: []};
    }

    var meshx = toDataCoords(valsx, 'xaxis');
    var meshy = toDataCoords(valsy, 'yaxis');
    var meshz = toDataCoords(valsz, 'zaxis');

    tubeOpts.meshgrid = [meshx, meshy, meshz];

    // TODO make this optional?
    // Default to in-between x/y/z mesh
    tubeOpts.startingPositions = zip3(
        toDataCoords(trace.startx, 'xaxis'),
        toDataCoords(trace.starty, 'yaxis'),
        toDataCoords(trace.startz, 'zaxis')
    );

    tubeOpts.colormap = parseColorScale(trace.colorscale);

    // TODO
    // tubeOpts.maxLength

    tubeOpts.tubeSize = trace.sizeref;

    // add some padding around the bounds
    // to e.g. allow tubes starting from a slice of the x/y/z mesh
    // to go beyond bounds a little bit w/o getting clipped
    var xbnds = toDataCoords(trace._xbnds, 'xaxis');
    var ybnds = toDataCoords(trace._ybnds, 'yaxis');
    var zbnds = toDataCoords(trace._zbnds, 'zaxis');
    var xpads = getBoundPads(meshx);
    var ypads = getBoundPads(meshy);
    var zpads = getBoundPads(meshz);

    var bounds = [
        [xbnds[0] - xpads[0], ybnds[0] - ypads[0], zbnds[0] - zpads[0]],
        [xbnds[1] + xpads[1], ybnds[1] + ypads[1], zbnds[1] + zpads[1]]
    ];

    var meshData = tube2mesh(tubeOpts, bounds);

    // N.B. cmin/cmax correspond to the min/max vector norm
    // in the u/v/w arrays, which in general is NOT equal to max
    // intensity that colors the tubes.
    meshData.vertexIntensityBounds = [trace.cmin / trace._normMax, trace.cmax / trace._normMax];

    // pass gl-mesh3d lighting attributes
    var lp = trace.lightposition;
    meshData.lightPosition = [lp.x, lp.y, lp.z];
    meshData.ambient = trace.lighting.ambient;
    meshData.diffuse = trace.lighting.diffuse;
    meshData.specular = trace.lighting.specular;
    meshData.roughness = trace.lighting.roughness;
    meshData.fresnel = trace.lighting.fresnel;
    meshData.opacity = trace.opacity;

    // TODO
    // stash autorange pad value
    // - include pad!
    // - include tubeScale
//     trace._pad = meshData.tubeScale * trace.sizeref;
//     if(trace.sizemode === 'scaled') trace._pad *= trace._normMax;

    return meshData;
}

proto.update = function(data) {
    this.data = data;

    var meshData = convert(this.scene, data);
    this.mesh.update(meshData);
};

proto.dispose = function() {
    this.scene.glplot.remove(this.mesh);
    this.mesh.dispose();
};

function createStreamtubeTrace(scene, data) {
    var gl = scene.glplot.gl;

    var meshData = convert(scene, data);
    var mesh = createTubeMesh(gl, meshData);

    var streamtube = new Streamtube(scene, data.uid);
    streamtube.mesh = mesh;
    streamtube.data = data;
    mesh._trace = streamtube;

    scene.glplot.add(mesh);

    return streamtube;
}

module.exports = createStreamtubeTrace;
