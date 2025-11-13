#!/usr/bin/env node

const VERSION = require('./package.json').version;
const express = require('express');
// const util = require('util');

/** @type {number} */
const PORT = process.env.PORT ?? 7000;
const prefix = 'tvgarden:';
const defaultType = 'TVGarden';

const app = express();
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS')
        return res.sendStatus(204);
    next();
});

/** @typedef {{[id: string]: string}?} Countries */
/** @type {Countries?} */
let countries;
/** @typedef {{[id: string]: string[]}?} Catalogs */
/** @type {Catalogs?} */
let catalogs;
/** @typedef {{[id: string]: {name: string, urls: string[], youtube_urls: string[], language: string, country: string, category: string?}}?} Streams */
/** @type {Streams?} */
let streams;
let lastFetchTime = 0;
async function getData() {
    const now = Date.now();
    if (countries && catalogs && streams && (now - lastFetchTime) < 3600000) return;
    lastFetchTime = now;
    try {
        /** @type {Countries} */
        const countries2 = Object.fromEntries(Object.entries(await (await fetch('https://raw.githubusercontent.com/TVGarden/tv-garden-channel-list/main/channels/raw/countries_metadata.json')).json()).map(([x, y]) => [x.toLowerCase(), y.country]));
        /** @type {Catalogs} */
        const catalogs2 = {};
        /** @type {Streams} */
        const streams2 = {};

        await Promise.all((await (await fetch('https://api.github.com/repos/TVGarden/tv-garden-channel-list/contents/channels/raw/countries')).json())
            .map(async x => {
                catalogs2[x.name.slice(0, -'.json'.length)] = [];
                (await (await fetch('https://raw.githubusercontent.com/TVGarden/tv-garden-channel-list/main/channels/raw/countries/' + x.name)).json())
                    .forEach(y => {
                        catalogs2[y.country].push(y.nanoid);
                        streams2[y.nanoid] = {
                            name: y.name ?? 'Unknown',
                            urls: y.iptv_urls ?? [],
                            youtube_urls: y.youtube_urls ?? [],
                            language: y.language ?? '',
                            country: y.country ?? ''
                        };
                    });
            }));
        await Promise.all((await (await fetch('https://api.github.com/repos/TVGarden/tv-garden-channel-list/contents/channels/raw/categories')).json())
            .map(async x => (x.name !== 'all-channels.json' ? (await (await fetch('https://raw.githubusercontent.com/TVGarden/tv-garden-channel-list/main/channels/raw/categories/' + x.name)).json()) : [])
                .forEach(y => streams2[y.nanoid].category = x.name.slice(0, -'.json'.length))
            ));

        countries = countries2;
        catalogs = catalogs2;
        streams = streams2;
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Stream fetching: ' + error);
    }
}

// Stremio Addon Manifest Route
app.get('/manifest.json', async (req, res) => {
    try {
        await getData();
        return res.json({
            id: 'tvgardenio.vercel.app',
            version: VERSION,
            name: 'TVGardenio | Vercel',
            description: 'Play TVGarden live-streams.',
            resources: ['catalog', 'meta'],
            types: [defaultType],
            idPrefixes: [prefix],
            catalogs: Object.entries(catalogs ?? {}).map(([x, y]) => ({
                type: defaultType,
                id: prefix + x,
                name: countries?.[x],
                extra: [{
                    name: 'genre',
                    options: [...new Set(y.map(z => streams?.[z].category).filter(Boolean))]
                }]
            })),
            logo: `https://github.com/xXCrash2BomberXx/TVGardenio/blob/${process.env.DEV_LOGGING ? 'main' : `v${VERSION}`}/icon.png?raw=true`,
            "stremioAddonsConfig": {
                "issuer": "https://stremio-addons.net",
                "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..z-aptRhGjAXG1c8zfXFgTQ.LdwD3y8_TTfnZnZ8pkXi4GVjC3I9HEl7iKCKDAksJ9W-PrgIJuMgDDN6jFP7v2gszADiRDbrAoLaLuvBr1ANxPfz1WO6CemsvgNpHoweux1pqKoMU2rS0-0Ff3q_y6mG.ktbxvazo9vrPYhUIeCh7tA"
            }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Manifest handler: ' + error);
        return res.json({});
    }
});

// Stremio Addon Catalog Route
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Catalog handler: "${req.params.id}"`);
        const genre = Object.fromEntries(new URLSearchParams(req.params.extra ?? '')).genre;
        await getData();
        return res.json({
            metas: Object.values(catalogs?.[req.params.id.slice(prefix.length)] ?? {}).flatMap(x => {
                const stream = streams?.[x];
                if (!stream) throw new Error(`Unknown stream ID in Catalog handler: "${x}"`);
                if (genre && stream.category !== genre) return [];
                return {
                    id: prefix + x,
                    type: req.params.type,
                    name: stream.name
                };
            })
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Catalog handler: ' + error);
        return res.json({ metas: [] });
    }
});

// Stremio Addon Meta Route
app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        if (!req.params.id?.startsWith(prefix)) throw new Error(`Unknown ID in Meta handler: "${req.params.id}"`);
        await getData();
        const stream = streams?.[req.params.id.slice(prefix.length)];
        if (!stream) throw new Error(`Unknown stream ID in Meta handler: "${req.params.id}"`);
        return res.json({
            meta: {
                id: req.params.id,
                type: req.params.type,
                name: stream.name,
                videos: [{
                    id: req.params.id + ':1:1',
                    title: stream.name,
                    released: new Date(0).toISOString(),
                    streams: [...stream.urls.map(x => ({
                        url: x,
                        behaviorHints: { notWebReady: true }
                    })), ...stream.youtube_urls.map(x => ({
                        ytId: x.match(/[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/)?.[0]
                    }))]
                }],
                language: stream.language,
                country: stream.country,
                website: `https://tv.garden/${stream.country}/${req.params.id.slice(prefix.length)}`,
                behaviorHints: { defaultVideoId: req.params.id + ':1:1' }
            }
        });
    } catch (error) {
        if (process.env.DEV_LOGGING) console.error('Error in Meta handler: ' + error);
        return res.json({ meta: {} });
    }
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    if (process.env.DEV_LOGGING) console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Addon server v${VERSION} running on port ${PORT}`);
    console.log(`Access the configuration page at: ${process.env.SPACE_HOST ? 'https://' + process.env.SPACE_HOST : 'http://localhost:' + PORT}`);
});
