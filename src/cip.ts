import * as readline from 'readline';
import { performCompetitorAnalysis } from './deep-research';
import { OutputManager } from './output-manager';

const output = new OutputManager();

// Helper function for consistent logging
function log(...args: any[]) {
  output.log(...args);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to get user input
function askQuestion(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, answer => {
      resolve(answer);
    });
  });
}

async function main() {
  try {
    const indication = await askQuestion('Which disease indication would you like to research? ');
    
    if (!indication) {
      throw new Error('Disease indication is required');
    }

    log(`Starting competitor analysis for ${indication}...`);

    await performCompetitorAnalysis(indication, (progress) => {
      output.updateProgress({
        currentDepth: progress.currentDepth,
        totalDepth: progress.totalDepth,
        currentBreadth: progress.currentBreadth,
        totalBreadth: progress.totalBreadth,
        currentQuery: progress.currentQuery,
        totalQueries: progress.totalQueries,
        completedQueries: progress.completedQueries
      });
    });

    log(`Analysis complete! Results saved to ${indication.toLowerCase().replace(/\s+/g, '-')}-analysis.csv`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    rl.close();
  }
}

main().catch(console.error); 