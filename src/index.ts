import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const agent = await createAgent({
  name: 'wiki-intel',
  version: '1.0.0',
  description: 'Wikipedia & Wikidata knowledge intelligence - entity search, summaries, and structured data. B2A optimized for agent knowledge lookups.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON with error handling ===
async function fetchJSON(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'wiki-intel/1.0 (https://langoustine69.dev)' }
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// === HELPER: Search Wikidata entities ===
async function searchWikidata(query: string, limit: number = 10, language: string = 'en') {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${language}&format=json&limit=${limit}`;
  const data = await fetchJSON(url);
  return data.search?.map((item: any) => ({
    id: item.id,
    label: item.label,
    description: item.description || null,
    url: `https://www.wikidata.org/wiki/${item.id}`,
    wikipediaUrl: item.url ? `https://en.wikipedia.org/wiki/${item.label.replace(/ /g, '_')}` : null
  })) || [];
}

// === HELPER: Get Wikipedia summary ===
async function getWikipediaSummary(title: string, language: string = 'en') {
  const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const data = await fetchJSON(url);
    return {
      title: data.title,
      description: data.description || null,
      extract: data.extract,
      thumbnail: data.thumbnail?.source || null,
      contentUrls: data.content_urls?.desktop || null,
      coordinates: data.coordinates || null,
      wikidataId: data.wikibase_item || null
    };
  } catch (e) {
    return null;
  }
}

// === HELPER: Get Wikidata entity details ===
async function getWikidataEntity(entityId: string, language: string = 'en') {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entityId}&languages=${language}&format=json`;
  const data = await fetchJSON(url);
  const entity = data.entities?.[entityId];
  if (!entity) return null;

  const labels = entity.labels?.[language]?.value || entity.labels?.en?.value;
  const descriptions = entity.descriptions?.[language]?.value || entity.descriptions?.en?.value;
  const aliases = entity.aliases?.[language]?.map((a: any) => a.value) || [];
  
  // Extract key claims/properties
  const claims: Record<string, any> = {};
  const importantProps = ['P31', 'P279', 'P361', 'P527', 'P17', 'P131', 'P569', 'P570', 'P18', 'P856'];
  const propNames: Record<string, string> = {
    'P31': 'instanceOf',
    'P279': 'subclassOf', 
    'P361': 'partOf',
    'P527': 'hasParts',
    'P17': 'country',
    'P131': 'locatedIn',
    'P569': 'dateOfBirth',
    'P570': 'dateOfDeath',
    'P18': 'image',
    'P856': 'officialWebsite'
  };
  
  for (const prop of importantProps) {
    if (entity.claims?.[prop]) {
      const values = entity.claims[prop].map((claim: any) => {
        const mainsnak = claim.mainsnak;
        if (mainsnak.datavalue?.type === 'wikibase-entityid') {
          return mainsnak.datavalue.value?.id;
        } else if (mainsnak.datavalue?.type === 'time') {
          return mainsnak.datavalue.value?.time;
        } else if (mainsnak.datavalue?.type === 'string') {
          return mainsnak.datavalue.value;
        }
        return mainsnak.datavalue?.value;
      }).filter(Boolean);
      if (values.length) claims[propNames[prop] || prop] = values;
    }
  }

  return {
    id: entityId,
    label: labels,
    description: descriptions,
    aliases,
    claims,
    sitelinks: Object.keys(entity.sitelinks || {}).length,
    url: `https://www.wikidata.org/wiki/${entityId}`
  };
}

// === HELPER: Get related entities ===
async function getRelatedEntities(entityId: string, language: string = 'en') {
  const entity = await getWikidataEntity(entityId, language);
  if (!entity) return [];
  
  const relatedIds = new Set<string>();
  for (const values of Object.values(entity.claims)) {
    if (Array.isArray(values)) {
      for (const v of values) {
        if (typeof v === 'string' && v.startsWith('Q')) {
          relatedIds.add(v);
        }
      }
    }
  }
  
  // Fetch details for related entities (limit to 10)
  const ids = Array.from(relatedIds).slice(0, 10);
  if (ids.length === 0) return [];
  
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join('|')}&languages=${language}&props=labels|descriptions&format=json`;
  const data = await fetchJSON(url);
  
  return Object.entries(data.entities || {}).map(([id, e]: [string, any]) => ({
    id,
    label: e.labels?.[language]?.value || e.labels?.en?.value || id,
    description: e.descriptions?.[language]?.value || e.descriptions?.en?.value || null
  }));
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - sample entity lookup to try before you buy',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const sample = await searchWikidata('artificial intelligence', 3);
    return {
      output: {
        service: 'wiki-intel',
        description: 'Wikipedia & Wikidata knowledge intelligence for AI agents',
        capabilities: ['entity search', 'summaries', 'structured data', 'related entities', 'batch lookup'],
        sampleSearch: sample,
        dataSources: ['Wikipedia REST API', 'Wikidata API'],
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 1: Entity Search ($0.001) ===
addEntrypoint({
  key: 'search',
  description: 'Search for entities by name/keyword across Wikidata',
  input: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().min(1).max(50).optional().default(10),
    language: z.string().optional().default('en')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const results = await searchWikidata(ctx.input.query, ctx.input.limit, ctx.input.language);
    return {
      output: {
        query: ctx.input.query,
        count: results.length,
        results,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2: Entity Summary ($0.002) ===
addEntrypoint({
  key: 'summary',
  description: 'Get Wikipedia summary for an entity by title',
  input: z.object({
    title: z.string().describe('Wikipedia article title (e.g., "Elon Musk")'),
    language: z.string().optional().default('en')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const summary = await getWikipediaSummary(ctx.input.title, ctx.input.language);
    if (!summary) {
      return { output: { error: 'Article not found', title: ctx.input.title } };
    }
    return {
      output: {
        ...summary,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3: Entity Details ($0.002) ===
addEntrypoint({
  key: 'details',
  description: 'Get structured Wikidata entity details by Wikidata ID',
  input: z.object({
    entityId: z.string().describe('Wikidata entity ID (e.g., "Q937" for Albert Einstein)'),
    language: z.string().optional().default('en')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const entity = await getWikidataEntity(ctx.input.entityId, ctx.input.language);
    if (!entity) {
      return { output: { error: 'Entity not found', entityId: ctx.input.entityId } };
    }
    return {
      output: {
        ...entity,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4: Related Entities ($0.003) ===
addEntrypoint({
  key: 'related',
  description: 'Get entities related to a given Wikidata entity',
  input: z.object({
    entityId: z.string().describe('Wikidata entity ID (e.g., "Q937")'),
    language: z.string().optional().default('en')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const [entity, related] = await Promise.all([
      getWikidataEntity(ctx.input.entityId, ctx.input.language),
      getRelatedEntities(ctx.input.entityId, ctx.input.language)
    ]);
    return {
      output: {
        sourceEntity: entity ? { id: entity.id, label: entity.label } : null,
        relatedCount: related.length,
        relatedEntities: related,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5: Batch Lookup ($0.005) ===
addEntrypoint({
  key: 'batch',
  description: 'Look up multiple entities at once with summaries',
  input: z.object({
    queries: z.array(z.string()).min(1).max(10).describe('Array of entity names to look up'),
    language: z.string().optional().default('en')
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const results = await Promise.all(
      ctx.input.queries.map(async (query) => {
        const search = await searchWikidata(query, 1, ctx.input.language);
        if (search.length === 0) return { query, found: false };
        
        const entity = search[0];
        const summary = await getWikipediaSummary(entity.label, ctx.input.language);
        
        return {
          query,
          found: true,
          entity: {
            id: entity.id,
            label: entity.label,
            description: entity.description,
            summary: summary?.extract || null,
            thumbnail: summary?.thumbnail || null
          }
        };
      })
    );
    
    return {
      output: {
        queriesCount: ctx.input.queries.length,
        foundCount: results.filter(r => r.found).length,
        results,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      }
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  try {
    const fs = await import('fs');
    const icon = fs.readFileSync('./icon.png');
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png' }
    });
  } catch {
    return c.json({ error: 'Icon not found' }, 404);
  }
});

// ERC-8004 registration file
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://wiki-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "wiki-intel",
    description: "Wikipedia & Wikidata knowledge intelligence - entity search, summaries, and structured data. B2A optimized for agent knowledge lookups. Pricing: $0.001-$0.005 per query.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`wiki-intel running on port ${port}`);

export default { port, fetch: app.fetch };
