import katex from 'katex';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

Object.assign(globalThis.GptExporterVendors ||= {}, {katex, MarkdownIt, DOMPurify});
