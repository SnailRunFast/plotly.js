/**
* Copyright 2012-2019, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/

'use strict';

var c = require('./constants');
var d3 = require('d3');
var tinycolor = require('tinycolor2');
var Color = require('../../components/color');
var Drawing = require('../../components/drawing');
var d3Sankey = require('@plotly/d3-sankey');
var d3SankeyCircular = require('d3-sankey-circular');
var d3Force = require('d3-force');
var Lib = require('../../lib');
var gup = require('../../lib/gup');
var keyFun = gup.keyFun;
var repeat = gup.repeat;
var unwrap = gup.unwrap;
var interpolateNumber = require('d3-interpolate').interpolateNumber;

// view models

function sankeyModel(layout, d, traceIndex) {
    var calcData = unwrap(d);
    var trace = calcData.trace;
    var domain = trace.domain;
    var horizontal = trace.orientation === 'h';
    var nodePad = trace.node.pad;
    var nodeThickness = trace.node.thickness;

    var width = layout.width * (domain.x[1] - domain.x[0]);
    var height = layout.height * (domain.y[1] - domain.y[0]);

    var nodes = calcData._nodes;
    var links = calcData._links;
    var circular = calcData.circular;

    // Select Sankey generator
    var sankey;
    if(circular) {
        sankey = d3SankeyCircular
            .sankeyCircular()
            .circularLinkGap(0)
            .nodeId(function(d) {
                return d.pointNumber;
            });
    } else {
        sankey = d3Sankey.sankey();
    }

    sankey
      .iterations(c.sankeyIterations)
      .size(horizontal ? [width, height] : [height, width])
      .nodeWidth(nodeThickness)
      .nodePadding(nodePad)
      .nodes(nodes)
      .links(links);

    var graph = sankey();

    if(sankey.nodePadding() < nodePad) {
        Lib.warn('node.pad was reduced to ', sankey.nodePadding(), ' to fit within the figure.');
    }

    function computeLinkConcentrations() {
        var i, j, k;
        for(i = 0; i < graph.nodes.length; i++) {
            var node = graph.nodes[i];
            // Links connecting the same two nodes are part of a flow
            var flows = {};
            var flowKey;
            var link;
            for(j = 0; j < node.targetLinks.length; j++) {
                link = node.targetLinks[j];
                flowKey = link.source.pointNumber + ':' + link.target.pointNumber;
                if(!flows.hasOwnProperty(flowKey)) flows[flowKey] = [];
                flows[flowKey].push(link);
            }

            // Compute statistics for each flow
            var keys = Object.keys(flows);
            for(j = 0; j < keys.length; j++) {
                flowKey = keys[j];
                var flowLinks = flows[flowKey];

                // Find the total size of the flow and total size per label
                var total = 0;
                var totalPerLabel = {};
                for(k = 0; k < flowLinks.length; k++) {
                    link = flowLinks[k];
                    if(!totalPerLabel[link.label]) totalPerLabel[link.label] = 0;
                    totalPerLabel[link.label] += link.value;
                    total += link.value;
                }

                // Find the ratio of the link's value and the size of the flow
                for(k = 0; k < flowLinks.length; k++) {
                    link = flowLinks[k];
                    link.flow = {
                        value: total,
                        labelConcentration: totalPerLabel[link.label] / total,
                        concentration: link.value / total,
                        links: flowLinks
                    };
                }
            }

            // Gather statistics of all links at current node
            var totalOutflow = 0;
            for(j = 0; j < node.sourceLinks.length; j++) {
                totalOutflow += node.sourceLinks[j].value;
            }
            for(j = 0; j < node.sourceLinks.length; j++) {
                link = node.sourceLinks[j];
                link.concentrationOut = link.value / totalOutflow;
            }

            var totalInflow = 0;
            for(j = 0; j < node.targetLinks.length; j++) {
                totalInflow += node.targetLinks[j].value;
            }

            for(j = 0; j < node.targetLinks.length; j++) {
                link = node.targetLinks[j];
                link.concenrationIn = link.value / totalInflow;
            }
        }
    }
    computeLinkConcentrations();

    return {
        circular: circular,
        key: traceIndex,
        trace: trace,
        guid: Math.floor(1e12 * (1 + Math.random())),
        horizontal: horizontal,
        width: width,
        height: height,
        nodePad: trace.node.pad,
        nodeLineColor: trace.node.line.color,
        nodeLineWidth: trace.node.line.width,
        linkLineColor: trace.link.line.color,
        linkLineWidth: trace.link.line.width,
        valueFormat: trace.valueformat,
        valueSuffix: trace.valuesuffix,
        textFont: trace.textfont,
        translateX: domain.x[0] * layout.width + layout.margin.l,
        translateY: layout.height - domain.y[1] * layout.height + layout.margin.t,
        dragParallel: horizontal ? height : width,
        dragPerpendicular: horizontal ? width : height,
        arrangement: trace.arrangement,
        sankey: sankey,
        graph: graph,
        forceLayouts: {},
        interactionState: {
            dragInProgress: false,
            hovered: false
        }
    };
}

function linkModel(d, l, i) {
    var tc = tinycolor(l.color);
    if(l.concentrationscale) {
        tc = tinycolor(l.concentrationscale(l.flow.labelConcentration));
    }
    var basicKey = l.source.label + '|' + l.target.label;
    var key = basicKey + '__' + i;

    // for event data
    l.trace = d.trace;
    l.curveNumber = d.trace.index;

    return {
        circular: d.circular,
        key: key,
        traceId: d.key,
        pointNumber: l.pointNumber,
        link: l,
        tinyColorHue: Color.tinyRGB(tc),
        tinyColorAlpha: tc.getAlpha(),
        linkLineColor: d.linkLineColor,
        linkLineWidth: d.linkLineWidth,
        valueFormat: d.valueFormat,
        valueSuffix: d.valueSuffix,
        sankey: d.sankey,
        parent: d,
        interactionState: d.interactionState,
        flow: l.flow
    };
}

function createCircularClosedPathString(link) {
    // Using coordinates computed by d3-sankey-circular
    var pathString = '';
    var offset = link.width / 2;
    var coords = link.circularPathData;
    if(link.circularLinkType === 'top') {
        // Top path
        pathString =
          // start at the left of the target node
          'M ' +
          coords.targetX + ' ' + (coords.targetY + offset) + ' ' +
          'L' +
          coords.rightInnerExtent + ' ' + (coords.targetY + offset) +
          'A' +
          (coords.rightLargeArcRadius + offset) + ' ' + (coords.rightSmallArcRadius + offset) + ' 0 0 1 ' +
          (coords.rightFullExtent - offset) + ' ' + (coords.targetY - coords.rightSmallArcRadius) +
          'L' +
          (coords.rightFullExtent - offset) + ' ' + coords.verticalRightInnerExtent +
          'A' +
          (coords.rightLargeArcRadius + offset) + ' ' + (coords.rightLargeArcRadius + offset) + ' 0 0 1 ' +
          coords.rightInnerExtent + ' ' + (coords.verticalFullExtent - offset) +
          'L' +
          coords.leftInnerExtent + ' ' + (coords.verticalFullExtent - offset) +
          'A' +
          (coords.leftLargeArcRadius + offset) + ' ' + (coords.leftLargeArcRadius + offset) + ' 0 0 1 ' +
          (coords.leftFullExtent + offset) + ' ' + coords.verticalLeftInnerExtent +
          'L' +
          (coords.leftFullExtent + offset) + ' ' + (coords.sourceY - coords.leftSmallArcRadius) +
          'A' +
          (coords.leftLargeArcRadius + offset) + ' ' + (coords.leftSmallArcRadius + offset) + ' 0 0 1 ' +
          coords.leftInnerExtent + ' ' + (coords.sourceY + offset) +
          'L' +
          coords.sourceX + ' ' + (coords.sourceY + offset) +

          // Walking back
          'L' +
          coords.sourceX + ' ' + (coords.sourceY - offset) +
          'L' +
          coords.leftInnerExtent + ' ' + (coords.sourceY - offset) +
          'A' +
          (coords.leftLargeArcRadius - offset) + ' ' + (coords.leftSmallArcRadius - offset) + ' 0 0 0 ' +
          (coords.leftFullExtent - offset) + ' ' + (coords.sourceY - coords.leftSmallArcRadius) +
          'L' +
          (coords.leftFullExtent - offset) + ' ' + coords.verticalLeftInnerExtent +
          'A' +
          (coords.leftLargeArcRadius - offset) + ' ' + (coords.leftLargeArcRadius - offset) + ' 0 0 0 ' +
          coords.leftInnerExtent + ' ' + (coords.verticalFullExtent + offset) +
          'L' +
          coords.rightInnerExtent + ' ' + (coords.verticalFullExtent + offset) +
          'A' +
          (coords.rightLargeArcRadius - offset) + ' ' + (coords.rightLargeArcRadius - offset) + ' 0 0 0 ' +
          (coords.rightFullExtent + offset) + ' ' + coords.verticalRightInnerExtent +
          'L' +
          (coords.rightFullExtent + offset) + ' ' + (coords.targetY - coords.rightSmallArcRadius) +
          'A' +
          (coords.rightLargeArcRadius - offset) + ' ' + (coords.rightSmallArcRadius - offset) + ' 0 0 0 ' +
          coords.rightInnerExtent + ' ' + (coords.targetY - offset) +
          'L' +
          coords.targetX + ' ' + (coords.targetY - offset) +
          'Z';
    } else {
        // Bottom path
        pathString =
          // start at the left of the target node
          'M ' +
          coords.targetX + ' ' + (coords.targetY - offset) + ' ' +
          'L' +
          coords.rightInnerExtent + ' ' + (coords.targetY - offset) +
          'A' +
          (coords.rightLargeArcRadius + offset) + ' ' + (coords.rightSmallArcRadius + offset) + ' 0 0 0 ' +
          (coords.rightFullExtent - offset) + ' ' + (coords.targetY + coords.rightSmallArcRadius) +
          'L' +
          (coords.rightFullExtent - offset) + ' ' + coords.verticalRightInnerExtent +
          'A' +
          (coords.rightLargeArcRadius + offset) + ' ' + (coords.rightLargeArcRadius + offset) + ' 0 0 0 ' +
          coords.rightInnerExtent + ' ' + (coords.verticalFullExtent + offset) +
          'L' +
          coords.leftInnerExtent + ' ' + (coords.verticalFullExtent + offset) +
          'A' +
          (coords.leftLargeArcRadius + offset) + ' ' + (coords.leftLargeArcRadius + offset) + ' 0 0 0 ' +
          (coords.leftFullExtent + offset) + ' ' + coords.verticalLeftInnerExtent +
          'L' +
          (coords.leftFullExtent + offset) + ' ' + (coords.sourceY + coords.leftSmallArcRadius) +
          'A' +
          (coords.leftLargeArcRadius + offset) + ' ' + (coords.leftSmallArcRadius + offset) + ' 0 0 0 ' +
          coords.leftInnerExtent + ' ' + (coords.sourceY - offset) +
          'L' +
          coords.sourceX + ' ' + (coords.sourceY - offset) +

          // Walking back
          'L' +
          coords.sourceX + ' ' + (coords.sourceY + offset) +
          'L' +
          coords.leftInnerExtent + ' ' + (coords.sourceY + offset) +
          'A' +
          (coords.leftLargeArcRadius - offset) + ' ' + (coords.leftSmallArcRadius - offset) + ' 0 0 1 ' +
          (coords.leftFullExtent - offset) + ' ' + (coords.sourceY + coords.leftSmallArcRadius) +
          'L' +
          (coords.leftFullExtent - offset) + ' ' + coords.verticalLeftInnerExtent +
          'A' +
          (coords.leftLargeArcRadius - offset) + ' ' + (coords.leftLargeArcRadius - offset) + ' 0 0 1 ' +
          coords.leftInnerExtent + ' ' + (coords.verticalFullExtent - offset) +
          'L' +
          coords.rightInnerExtent + ' ' + (coords.verticalFullExtent - offset) +
          'A' +
          (coords.rightLargeArcRadius - offset) + ' ' + (coords.rightLargeArcRadius - offset) + ' 0 0 1 ' +
          (coords.rightFullExtent + offset) + ' ' + coords.verticalRightInnerExtent +
          'L' +
          (coords.rightFullExtent + offset) + ' ' + (coords.targetY + coords.rightSmallArcRadius) +
          'A' +
          (coords.rightLargeArcRadius - offset) + ' ' + (coords.rightSmallArcRadius - offset) + ' 0 0 1 ' +
          coords.rightInnerExtent + ' ' + (coords.targetY + offset) +
          'L' +
          coords.targetX + ' ' + (coords.targetY + offset) +
          'Z';
    }
    return pathString;
}

function linkPath() {
    var curvature = 0.5;
    function path(d) {
        if(d.link.circular) {
            return createCircularClosedPathString(d.link);
        } else {
            var x0 = d.link.source.x1;
            var x1 = d.link.target.x0;
            var xi = interpolateNumber(x0, x1);
            var x2 = xi(curvature);
            var x3 = xi(1 - curvature);
            var y0a = d.link.y0 - d.link.width / 2;
            var y0b = d.link.y0 + d.link.width / 2;
            var y1a = d.link.y1 - d.link.width / 2;
            var y1b = d.link.y1 + d.link.width / 2;
            return 'M' + x0 + ',' + y0a +
                 'C' + x2 + ',' + y0a +
                 ' ' + x3 + ',' + y1a +
                 ' ' + x1 + ',' + y1a +
                 'L' + x1 + ',' + y1b +
                 'C' + x3 + ',' + y1b +
                 ' ' + x2 + ',' + y0b +
                 ' ' + x0 + ',' + y0b +
                 'Z';
        }
    }
    return path;
}

function nodeModel(d, n, i) {
    var tc = tinycolor(n.color);
    var zoneThicknessPad = c.nodePadAcross;
    var zoneLengthPad = d.nodePad / 2;
    n.dx = n.x1 - n.x0;
    n.dy = n.y1 - n.y0;
    var visibleThickness = n.dx;
    var visibleLength = Math.max(0.5, n.dy);

    var basicKey = n.label;
    var key = basicKey + '__' + i;

    // for event data
    n.trace = d.trace;
    n.curveNumber = d.trace.index;

    return {
        index: n.pointNumber,
        key: key,
        traceId: d.key,
        node: n,
        nodePad: d.nodePad,
        nodeLineColor: d.nodeLineColor,
        nodeLineWidth: d.nodeLineWidth,
        textFont: d.textFont,
        size: d.horizontal ? d.height : d.width,
        visibleWidth: Math.ceil(visibleThickness),
        visibleHeight: visibleLength,
        zoneX: -zoneThicknessPad,
        zoneY: -zoneLengthPad,
        zoneWidth: visibleThickness + 2 * zoneThicknessPad,
        zoneHeight: visibleLength + 2 * zoneLengthPad,
        labelY: d.horizontal ? n.dy / 2 + 1 : n.dx / 2 + 1,
        left: n.originalLayer === 1,
        sizeAcross: d.width,
        forceLayouts: d.forceLayouts,
        horizontal: d.horizontal,
        darkBackground: tc.getBrightness() <= 128,
        tinyColorHue: Color.tinyRGB(tc),
        tinyColorAlpha: tc.getAlpha(),
        valueFormat: d.valueFormat,
        valueSuffix: d.valueSuffix,
        sankey: d.sankey,
        graph: d.graph,
        arrangement: d.arrangement,
        uniqueNodeLabelPathId: [d.guid, d.key, key].join('_'),
        interactionState: d.interactionState
    };
}

// rendering snippets

function updateNodePositions(sankeyNode) {
    sankeyNode
        .attr('transform', function(d) {
            return 'translate(' + d.node.x0.toFixed(3) + ', ' + (d.node.y0).toFixed(3) + ')';
        });
}

function updateNodeShapes(sankeyNode) {
    sankeyNode.call(updateNodePositions);
}

function updateShapes(sankeyNode, sankeyLink) {
    sankeyNode.call(updateNodeShapes);
    sankeyLink.attr('d', linkPath());
}

function sizeNode(rect) {
    rect
      .attr('width', function(d) {return d.node.x1 - d.node.x0;})
      .attr('height', function(d) {return d.visibleHeight;});
}

function salientEnough(d) {return (d.link.width > 1 || d.linkLineWidth > 0);}

function sankeyTransform(d) {
    var offset = 'translate(' + d.translateX + ',' + d.translateY + ')';
    return offset + (d.horizontal ? 'matrix(1 0 0 1 0 0)' : 'matrix(0 1 1 0 0 0)');
}

function nodeCentering(d) {
    return 'translate(' + (d.horizontal ? 0 : d.labelY) + ' ' + (d.horizontal ? d.labelY : 0) + ')';
}

function textGuidePath(d) {
    return d3.svg.line()([
        [d.horizontal ? (d.left ? -d.sizeAcross : d.visibleWidth + c.nodeTextOffsetHorizontal) : c.nodeTextOffsetHorizontal, 0],
        [d.horizontal ? (d.left ? - c.nodeTextOffsetHorizontal : d.sizeAcross) : d.visibleHeight - c.nodeTextOffsetHorizontal, 0]
    ]);}

function sankeyInverseTransform(d) {return d.horizontal ? 'matrix(1 0 0 1 0 0)' : 'matrix(0 1 1 0 0 0)';}
function textFlip(d) {return d.horizontal ? 'scale(1 1)' : 'scale(-1 1)';}
function nodeTextColor(d) {return d.darkBackground && !d.horizontal ? 'rgb(255,255,255)' : 'rgb(0,0,0)';}
function nodeTextOffset(d) {return d.horizontal && d.left ? '100%' : '0%';}

// event handling

function attachPointerEvents(selection, sankey, eventSet) {
    selection
        .on('.basic', null) // remove any preexisting handlers
        .on('mouseover.basic', function(d) {
            if(!d.interactionState.dragInProgress) {
                eventSet.hover(this, d, sankey);
                d.interactionState.hovered = [this, d];
            }
        })
        .on('mousemove.basic', function(d) {
            if(!d.interactionState.dragInProgress) {
                eventSet.follow(this, d);
                d.interactionState.hovered = [this, d];
            }
        })
        .on('mouseout.basic', function(d) {
            if(!d.interactionState.dragInProgress) {
                eventSet.unhover(this, d, sankey);
                d.interactionState.hovered = false;
            }
        })
        .on('click.basic', function(d) {
            if(d.interactionState.hovered) {
                eventSet.unhover(this, d, sankey);
                d.interactionState.hovered = false;
            }
            if(!d.interactionState.dragInProgress) {
                eventSet.select(this, d, sankey);
            }
        });
}

function attachDragHandler(sankeyNode, sankeyLink, callbacks) {
    var dragBehavior = d3.behavior.drag()
        .origin(function(d) {
            return {
                x: d.node.x0 + d.visibleWidth / 2,
                y: d.node.y0 + d.visibleHeight / 2
            };
        })

        .on('dragstart', function(d) {
            if(d.arrangement === 'fixed') return;
            Lib.raiseToTop(this);
            d.interactionState.dragInProgress = d.node;

            saveCurrentDragPosition(d.node);
            if(d.interactionState.hovered) {
                callbacks.nodeEvents.unhover.apply(0, d.interactionState.hovered);
                d.interactionState.hovered = false;
            }
            if(d.arrangement === 'snap') {
                var forceKey = d.traceId + '|' + d.key;
                if(d.forceLayouts[forceKey]) {
                    d.forceLayouts[forceKey].alpha(1);
                } else { // make a forceLayout if needed
                    attachForce(sankeyNode, forceKey, d);
                }
                startForce(sankeyNode, sankeyLink, d, forceKey);
            }
        })

        .on('drag', function(d) {
            if(d.arrangement === 'fixed') return;
            var x = d3.event.x;
            var y = d3.event.y;
            if(d.arrangement === 'snap') {
                d.node.x0 = x - d.visibleWidth / 2;
                d.node.x1 = x + d.visibleWidth / 2;
                d.node.y0 = y - d.visibleHeight / 2;
                d.node.y1 = y + d.visibleHeight / 2;
            } else {
                if(d.arrangement === 'freeform') {
                    d.node.x0 = x - d.visibleWidth / 2;
                    d.node.x1 = x + d.visibleWidth / 2;
                }
                d.node.y0 = Math.max(0, Math.min(d.size - d.visibleHeight, y));
                d.node.y1 = d.node.y0 + d.visibleHeight;
            }

            saveCurrentDragPosition(d.node);
            if(d.arrangement !== 'snap') {
                d.sankey.update(d.graph);
                updateShapes(sankeyNode.filter(sameLayer(d)), sankeyLink);
            }
        })

        .on('dragend', function(d) {
            d.interactionState.dragInProgress = false;
        });

    sankeyNode
        .on('.drag', null) // remove possible previous handlers
        .call(dragBehavior);
}

function attachForce(sankeyNode, forceKey, d) {
    // Attach force to nodes in the same column (same x coordinate)
    switchToForceFormat(d.graph.nodes);
    var nodes = d.graph.nodes.filter(function(n) {return n.originalX === d.node.originalX;});
    d.forceLayouts[forceKey] = d3Force.forceSimulation(nodes)
        .alphaDecay(0)
        .force('collide', d3Force.forceCollide()
            .radius(function(n) {return n.dy / 2 + d.nodePad / 2;})
            .strength(1)
            .iterations(c.forceIterations))
        .force('constrain', snappingForce(sankeyNode, forceKey, nodes, d))
        .stop();
}

function startForce(sankeyNode, sankeyLink, d, forceKey) {
    window.requestAnimationFrame(function faster() {
        var i;
        for(i = 0; i < c.forceTicksPerFrame; i++) {
            d.forceLayouts[forceKey].tick();
        }

        var nodes = d.graph.nodes;
        switchToSankeyFormat(nodes);

        d.sankey.update(d.graph);
        updateShapes(sankeyNode.filter(sameLayer(d)), sankeyLink);

        if(d.forceLayouts[forceKey].alpha() > 0) {
            window.requestAnimationFrame(faster);
        }
    });
}

function snappingForce(sankeyNode, forceKey, nodes, d) {
    return function _snappingForce() {
        var maxVelocity = 0;
        for(var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if(n === d.interactionState.dragInProgress) { // constrain node position to the dragging pointer
                n.x = n.lastDraggedX;
                n.y = n.lastDraggedY;
            } else {
                n.vx = (n.originalX - n.x) / c.forceTicksPerFrame; // snap to layer
                n.y = Math.min(d.size - n.dy / 2, Math.max(n.dy / 2, n.y)); // constrain to extent
            }
            maxVelocity = Math.max(maxVelocity, Math.abs(n.vx), Math.abs(n.vy));
        }
        if(!d.interactionState.dragInProgress && maxVelocity < 0.1 && d.forceLayouts[forceKey].alpha() > 0) {
            d.forceLayouts[forceKey].alpha(0);
        }
    };
}

// basic data utilities

function persistOriginalPlace(nodes) {
    var distinctLayerPositions = [];
    var i;
    for(i = 0; i < nodes.length; i++) {
        nodes[i].originalX = (nodes[i].x0 + nodes[i].x1) / 2;
        nodes[i].originalY = (nodes[i].y0 + nodes[i].y1) / 2;
        if(distinctLayerPositions.indexOf(nodes[i].originalX) === -1) {
            distinctLayerPositions.push(nodes[i].originalX);
        }
    }
    distinctLayerPositions.sort(function(a, b) {return a - b;});
    for(i = 0; i < nodes.length; i++) {
        nodes[i].originalLayerIndex = distinctLayerPositions.indexOf(nodes[i].originalX);
        nodes[i].originalLayer = nodes[i].originalLayerIndex / (distinctLayerPositions.length - 1);
    }
}

function saveCurrentDragPosition(d) {
    d.lastDraggedX = d.x0 + d.dx / 2;
    d.lastDraggedY = d.y0 + d.dy / 2;
}

function sameLayer(d) {
    return function(n) {return n.node.originalX === d.node.originalX;};
}

function switchToForceFormat(nodes) {
    // force uses x, y as centers
    for(var i = 0; i < nodes.length; i++) {
        nodes[i].y = nodes[i].y0 + nodes[i].dy / 2;
        nodes[i].x = nodes[i].x0 + nodes[i].dx / 2;
    }
}

function switchToSankeyFormat(nodes) {
    // sankey uses x0, x1, y0, y1
    for(var i = 0; i < nodes.length; i++) {
        nodes[i].y0 = nodes[i].y - nodes[i].dy / 2;
        nodes[i].y1 = nodes[i].y0 + nodes[i].dy;

        nodes[i].x0 = nodes[i].x - nodes[i].dx / 2;
        nodes[i].x1 = nodes[i].x0 + nodes[i].dx;
    }
}

// scene graph
module.exports = function(gd, svg, calcData, layout, callbacks) {

    var styledData = calcData
            .filter(function(d) {return unwrap(d).trace.visible;})
            .map(sankeyModel.bind(null, layout));

    var sankey = svg.selectAll('.' + c.cn.sankey)
        .data(styledData, keyFun);

    sankey.exit()
        .remove();

    sankey.enter()
        .append('g')
        .classed(c.cn.sankey, true)
        .style('box-sizing', 'content-box')
        .style('position', 'absolute')
        .style('left', 0)
        .style('shape-rendering', 'geometricPrecision')
        .style('pointer-events', 'auto')
        .attr('transform', sankeyTransform);

    sankey.transition()
        .ease(c.ease).duration(c.duration)
        .attr('transform', sankeyTransform);

    var sankeyLinks = sankey.selectAll('.' + c.cn.sankeyLinks)
        .data(repeat, keyFun);

    sankeyLinks.enter()
        .append('g')
        .classed(c.cn.sankeyLinks, true)
        .style('fill', 'none');

    var sankeyLink = sankeyLinks.selectAll('.' + c.cn.sankeyLink)
          .data(function(d) {
              var links = d.graph.links;
              return links
                .filter(function(l) {return l.value;})
                .map(linkModel.bind(null, d));
          }, keyFun);

    sankeyLink
          .enter().append('path')
          .classed(c.cn.sankeyLink, true)
          .attr('d', linkPath())
          .call(attachPointerEvents, sankey, callbacks.linkEvents);

    sankeyLink
        .style('stroke', function(d) {
            return salientEnough(d) ? Color.tinyRGB(tinycolor(d.linkLineColor)) : d.tinyColorHue;
        })
        .style('stroke-opacity', function(d) {
            return salientEnough(d) ? Color.opacity(d.linkLineColor) : d.tinyColorAlpha;
        })
        .style('fill', function(d) {
            return d.tinyColorHue;
        })
        .style('fill-opacity', function(d) {
            return d.tinyColorAlpha;
        })
        .style('stroke-width', function(d) {
            return salientEnough(d) ? d.linkLineWidth : 1;
        });

    sankeyLink.transition()
       .ease(c.ease).duration(c.duration)
       .attr('d', linkPath());

    sankeyLink.exit().transition()
        .ease(c.ease).duration(c.duration)
        .style('opacity', 0)
        .remove();

    var sankeyNodeSet = sankey.selectAll('.' + c.cn.sankeyNodeSet)
        .data(repeat, keyFun);

    sankeyNodeSet.enter()
        .append('g')
        .classed(c.cn.sankeyNodeSet, true);

    sankeyNodeSet
        .style('cursor', function(d) {
            switch(d.arrangement) {
                case 'fixed': return 'default';
                case 'perpendicular': return 'ns-resize';
                default: return 'move';
            }
        });

    var sankeyNode = sankeyNodeSet.selectAll('.' + c.cn.sankeyNode)
        .data(function(d) {
            var nodes = d.graph.nodes;
            persistOriginalPlace(nodes);
            return nodes
                .filter(function(n) {return n.value;})
                .map(nodeModel.bind(null, d));
        }, keyFun);

    sankeyNode.enter()
        .append('g')
        .classed(c.cn.sankeyNode, true)
        .call(updateNodePositions)
        .call(attachPointerEvents, sankey, callbacks.nodeEvents);

    sankeyNode
        .call(attachDragHandler, sankeyLink, callbacks); // has to be here as it binds sankeyLink

    sankeyNode.transition()
        .ease(c.ease).duration(c.duration)
        .call(updateNodePositions);

    sankeyNode.exit().transition()
        .ease(c.ease).duration(c.duration)
        .style('opacity', 0)
        .remove();

    var nodeRect = sankeyNode.selectAll('.' + c.cn.nodeRect)
        .data(repeat);

    nodeRect.enter()
        .append('rect')
        .classed(c.cn.nodeRect, true)
        .call(sizeNode);

    nodeRect
        .style('stroke-width', function(d) {return d.nodeLineWidth;})
        .style('stroke', function(d) {return Color.tinyRGB(tinycolor(d.nodeLineColor));})
        .style('stroke-opacity', function(d) {return Color.opacity(d.nodeLineColor);})
        .style('fill', function(d) {return d.tinyColorHue;})
        .style('fill-opacity', function(d) {return d.tinyColorAlpha;});

    nodeRect.transition()
        .ease(c.ease).duration(c.duration)
        .call(sizeNode);

    var nodeCapture = sankeyNode.selectAll('.' + c.cn.nodeCapture)
        .data(repeat);

    nodeCapture.enter()
        .append('rect')
        .classed(c.cn.nodeCapture, true)
        .style('fill-opacity', 0);

    nodeCapture
        .attr('x', function(d) {return d.zoneX;})
        .attr('y', function(d) {return d.zoneY;})
        .attr('width', function(d) {return d.zoneWidth;})
        .attr('height', function(d) {return d.zoneHeight;});

    var nodeCentered = sankeyNode.selectAll('.' + c.cn.nodeCentered)
        .data(repeat);

    nodeCentered.enter()
        .append('g')
        .classed(c.cn.nodeCentered, true)
        .attr('transform', nodeCentering);

    nodeCentered
        .transition()
        .ease(c.ease).duration(c.duration)
        .attr('transform', nodeCentering);

    var nodeLabelGuide = nodeCentered.selectAll('.' + c.cn.nodeLabelGuide)
        .data(repeat);

    nodeLabelGuide.enter()
        .append('path')
        .classed(c.cn.nodeLabelGuide, true)
        .attr('id', function(d) {return d.uniqueNodeLabelPathId;})
        .attr('d', textGuidePath)
        .attr('transform', sankeyInverseTransform);

    nodeLabelGuide
        .transition()
        .ease(c.ease).duration(c.duration)
        .attr('d', textGuidePath)
        .attr('transform', sankeyInverseTransform);

    var nodeLabel = nodeCentered.selectAll('.' + c.cn.nodeLabel)
        .data(repeat);

    nodeLabel.enter()
        .append('text')
        .classed(c.cn.nodeLabel, true)
        .attr('transform', textFlip)
        .style('user-select', 'none')
        .style('cursor', 'default')
        .style('fill', 'black');

    nodeLabel
        .style('text-shadow', function(d) {
            return d.horizontal ? '-1px 1px 1px #fff, 1px 1px 1px #fff, 1px -1px 1px #fff, -1px -1px 1px #fff' : 'none';
        })
        .each(function(d) {Drawing.font(nodeLabel, d.textFont);});

    nodeLabel
        .transition()
        .ease(c.ease).duration(c.duration)
        .attr('transform', textFlip);

    var nodeLabelTextPath = nodeLabel.selectAll('.' + c.cn.nodeLabelTextPath)
        .data(repeat);

    nodeLabelTextPath.enter()
        .append('textPath')
        .classed(c.cn.nodeLabelTextPath, true)
        .attr('alignment-baseline', 'middle')
        .attr('xlink:href', function(d) {return '#' + d.uniqueNodeLabelPathId;})
        .attr('startOffset', nodeTextOffset)
        .style('fill', nodeTextColor);

    nodeLabelTextPath
        .text(function(d) {return d.horizontal || d.node.dy > 5 ? d.node.label : '';})
        .attr('text-anchor', function(d) {return d.horizontal && d.left ? 'end' : 'start';});

    nodeLabelTextPath
        .transition()
        .ease(c.ease).duration(c.duration)
        .attr('startOffset', nodeTextOffset)
        .style('fill', nodeTextColor);
};
