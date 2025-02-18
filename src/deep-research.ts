import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';
import { createObjectCsvWriter } from 'csv-writer';
import path from 'path';

import { o3MiniModel, trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';
import { OutputManager } from './output-manager';
import { schema } from './schema';

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 2;

// Initialize Firecrawl with optional API key and optional base url

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

// take en user query, return a list of SERP queries
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;

  // optional, if provided, the research will continue from the last learning
  learnings?: string[];
}) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>\n\n${
      learnings
        ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
            '\n',
          )}`
        : ''
    }`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('The SERP query'),
            researchGoal: z
              .string()
              .describe(
                'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
              ),
          }),
        )
        .describe(`List of SERP queries, max of ${numQueries}`),
    }),
  });
  log(
    `Created ${res.object.queries.length} queries`,
    res.object.queries,
  );

  return res.object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(result.data.map(item => item.markdown)).map(
    content => trimPrompt(content, 25_000),
  );
  log(`Ran ${query}, found ${contents.length} contents`);

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates. The learnings will be used to research the topic further.\n\n<contents>${contents
      .map(content => `<content>\n${content}\n</content>`)
      .join('\n')}</contents>`,
    schema: z.object({
      learnings: z
        .array(z.string())
        .describe(`List of learnings, max of ${numLearnings}`),
      followUpQuestions: z
        .array(z.string())
        .describe(
          `List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
        ),
    }),
  });
  log(
    `Created ${res.object.learnings.length} learnings`,
    res.object.learnings,
  );

  return res.object;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );

  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from previous research:\n\n<learnings>\n${learningsString}\n</learnings>`,
    schema: z.object({
      reportMarkdown: z
        .string()
        .describe('Final report on the topic in Markdown'),
    }),
  });

  // Append the visited URLs section to the report
  const urlsSection = `\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  return res.object.reportMarkdown + urlsSection;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };
  
  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });
  
  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query
  });
  
  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await firecrawl.search(serpQuery.query, {
            timeout: 15000,
            limit: 5,
            scrapeOptions: { formats: ['markdown'] },
          });

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(
              `Timeout error running query: ${serpQuery.query}: `,
              e,
            );
          } else {
            log(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}

type DrugDiscoveryProgress = {
  status: 'discovering_drugs' | 'researching_drugs';
  currentDrug?: string;
  totalDrugs?: number;
  completedDrugs: number;
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

// First phase: Discover drugs for a given indication
async function discoverDrugsForIndication(indication: string, onProgress?: (progress: DrugDiscoveryProgress) => void) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following disease indication, generate SERP queries to discover all drugs (both approved and in development) for this indication: ${indication}`,
    schema: z.object({
      queries: z.array(z.string()),
    }),
  });

  const limit = pLimit(ConcurrencyLimit);
  const allDrugs = new Set<string>();
  let completedQueries = 0;

  await Promise.all(
    res.object.queries.map(query =>
      limit(async () => {
        try {
          onProgress?.({
            status: 'discovering_drugs',
            completedDrugs: 0,
            currentDepth: 1,
            totalDepth: 1,
            currentBreadth: completedQueries + 1,
            totalBreadth: res.object.queries.length,
            totalQueries: res.object.queries.length,
            completedQueries: completedQueries,
            currentQuery: query
          });

          const result = await firecrawl.search(query, {
            timeout: 15000,
            limit: 10,
            scrapeOptions: { formats: ['markdown'] },
          });

          // Process each search result in parallel
          const drugPromises = result.data.map(async (item) => {
            if (!item.markdown) return [];
            
            try {
              const drugsRes = await generateObject({
                model: o3MiniModel,
                system: systemPrompt(),
                prompt: `Given the following search result, extract all drug names (both approved and in development) mentioned for ${indication}. Include both brand names and generic names:\n\n${item.markdown}`,
                schema: z.object({
                  drugs: z.array(z.string()),
                }),
              });
              return drugsRes.object.drugs;
            } catch (e) {
              log(`Error extracting drugs from content: `, e);
              return [];
            }
          });

          const drugLists = await Promise.all(drugPromises);
          drugLists.flat().forEach(drug => allDrugs.add(drug));
          completedQueries++;

        } catch (e) {
          log(`Error discovering drugs: `, e);
          completedQueries++;
        }
      }),
    ),
  );

  return Array.from(allDrugs);
}

type DrugInfo = z.infer<typeof schema>;

// Second phase: Research specific drug details
async function researchDrug(drugName: string): Promise<DrugInfo> {
  const queries = [
    `${drugName} clinical trials status development phase`,
    `${drugName} mechanism of action pharmaceutical company`,
    `${drugName} drug modality administration route`,
  ];

  const limit = pLimit(ConcurrencyLimit);
  const searchResults: SearchResponse[] = [];

  await Promise.all(
    queries.map(query =>
      limit(async () => {
        try {
          const result = await firecrawl.search(query, {
            timeout: 15000,
            limit: 5,
            scrapeOptions: { formats: ['markdown'] },
          });
          searchResults.push(result);
        } catch (e) {
          log(`Error researching drug ${drugName}: `, e);
        }
      }),
    ),
  );

  // Process all search results in parallel
  const processingPromises = searchResults.flatMap(result =>
    result.data
      .filter(data => data.markdown)
      .map(async data => {
        try {
          const partialDrugInfo = await generateObject({
            model: o3MiniModel,
            system: systemPrompt(),
            prompt: `Given the following search result about ${drugName}, extract detailed information according to the schema. If you're not confident about certain fields, leave them empty:\n\n${data.markdown}`,
            schema,
          });
          
          return partialDrugInfo.object as DrugInfo;
        } catch (e) {
          log(`Error processing search result for ${drugName}: `, e);
          return null;
        }
      })
  );

  const drugInfoResults = (await Promise.all(processingPromises)).filter((result): result is DrugInfo => result !== null);

  // Combine all results into a final schema
  const finalDrugInfo = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given these different pieces of information about ${drugName}, combine them into a single coherent entry, resolving any conflicts and choosing the most accurate information:\n\n${JSON.stringify(drugInfoResults, null, 2)}`,
    schema,
  });

  return finalDrugInfo.object as DrugInfo;
}

export async function performCompetitorAnalysis(
  indication: string,
  onProgress?: (progress: DrugDiscoveryProgress) => void,
): Promise<DrugInfo[]> {
  log(`Discovering drugs for ${indication}...`);
  onProgress?.({
    status: 'discovering_drugs',
    completedDrugs: 0,
    currentDepth: 0,
    totalDepth: 1,
    currentBreadth: 0,
    totalBreadth: 1,
    totalQueries: 1,
    completedQueries: 0,
    currentQuery: 'Initial discovery'
  });

  const drugs = await discoverDrugsForIndication(indication, onProgress);
  log(`Discovered ${drugs.length} drugs`);

  // Phase 2: Research each drug
  const drugDetails: DrugInfo[] = [];
  let completedDrugs = 0;

  for (const drug of drugs) {
    onProgress?.({
      status: 'researching_drugs',
      currentDrug: drug,
      totalDrugs: drugs.length,
      completedDrugs,
      currentDepth: 1,
      totalDepth: 1,
      currentBreadth: completedDrugs + 1,
      totalBreadth: drugs.length,
      totalQueries: drugs.length,
      completedQueries: completedDrugs,
      currentQuery: drug
    });

    const details = await researchDrug(drug);
    drugDetails.push(details);
    completedDrugs++;
  }

  // Write results to CSV
  const csvPath = path.join(process.cwd(), `${indication.toLowerCase().replace(/\s+/g, '-')}-analysis.csv`);
  const csvWriter = createObjectCsvWriter({
    path: csvPath,
    header: [
      { id: 'drug_name', title: 'Drug Name' },
      { id: 'api_name', title: 'API Name' },
      { id: 'status', title: 'Status' },
      { id: 'drug_modality', title: 'Drug Modality' },
      { id: 'organization', title: 'Organization' },
      { id: 'clinical_trial_phase', title: 'Clinical Trial Phase' },
      { id: 'route_of_administration', title: 'Route of Administration' },
      { id: 'mode_of_action', title: 'Mode of Action' },
      // Complex fields as stringified JSON
      { id: 'description', title: 'Description' },
      { id: 'references', title: 'References' }
    ],
  });

  // Transform complex fields before writing
  const csvData = drugDetails.map(drug => ({
    ...drug,
    description: JSON.stringify(drug.description),
    references: JSON.stringify(drug.references)
  }));

  await csvWriter.writeRecords(csvData);
  log(`CSV file written to: ${csvPath}`);
  return drugDetails;
}
