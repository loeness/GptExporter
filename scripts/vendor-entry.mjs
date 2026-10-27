import pdfMake from 'pdfmake/build/pdfmake.js';
import mermaid from 'mermaid';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import html2canvas from 'html2canvas';
import {mathjax} from 'mathjax-full/js/mathjax.js';
import {TeX} from 'mathjax-full/js/input/tex.js';
import {SVG} from 'mathjax-full/js/output/svg.js';
import {liteAdaptor} from 'mathjax-full/js/adaptors/liteAdaptor.js';
import {RegisterHTMLHandler} from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js';
const mathAdaptor=liteAdaptor();RegisterHTMLHandler(mathAdaptor);
const mathDocument=mathjax.document('',{InputJax:new TeX({packages:['base','ams','newcommand','noundefined'],maxBuffer:20000,maxMacros:1000}),OutputJax:new SVG({fontCache:'none'})});
function renderMathSvg(tex,display){return mathAdaptor.outerHTML(mathDocument.convert(tex,{display,em:16,ex:8,containerWidth:800}));}
globalThis.GptExporterVendors = { pdfMake, mermaid, katex, MarkdownIt, DOMPurify, html2canvas,renderMathSvg };
