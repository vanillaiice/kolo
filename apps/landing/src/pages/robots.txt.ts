import type { APIRoute } from 'astro';
import { crawlBase } from './sitemap.xml';

export const GET: APIRoute = ({ site }) => new Response(`User-agent: *\nAllow: /\n\nSitemap: ${crawlBase(site)}sitemap.xml\n`);
