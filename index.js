import readline from 'readline'
import clipboardy from 'clipboardy'
import { generateObject } from 'ai'
import z from 'zod'
import { prompt } from './util.js'

// load .env
import 'dotenv/config'

const githubApiKey = process.env.GITHUB_API_KEY

// uncomment to switch to gpt-4o
import { openai } from '@ai-sdk/openai'
// const aiModel = openai('gpt-4o-mini')
const aiModel = openai('gpt-4o')

// import { anthropic } from '@ai-sdk/anthropic'
// const aiModel = anthropic('claude-3-5-sonnet-20240620')

export async function getCommit(commitUrl) {
    // Convert normal commit URL to API URL
    const urlParts = commitUrl.split('/');
    const owner = urlParts[3];
    const repo = urlParts[4];
    const commitSha = urlParts[6];
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}`;

    const headers = {
        'Authorization': `Bearer ${githubApiKey}`,
        'Accept': 'application/vnd.github.v3.json'
    };

    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json()
}

async function fetchRepoContents(repoUrl, path = '') {
    const urlParts = repoUrl.split('/');
    const owner = urlParts[3];
    const repo = urlParts[4];
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
        'Authorization': `token ${githubApiKey}`, // Replace with your GitHub token
        'Accept': 'application/vnd.github.v3+json'
    };

    try {
        const response = await fetch(apiUrl, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return response.json();
    } catch (error) {
        console.error('Error fetching repository contents:', error);
    }
}

async function getFileMetadata(repoUrl, filePath) {
    const urlParts = repoUrl.split('/');
    const owner = urlParts[3];
    const repo = urlParts[4];

    // Fetch the number of lines in the file
    const fileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${filePath}`;
    const fileResponse = await fetch(fileUrl);
    const fileContent = await fileResponse.text();
    const lineCount = fileContent.split('\n').length;

    // Fetch the number of commits for the file
    const commitsUrl = `https://api.github.com/repos/${owner}/${repo}/commits?path=${filePath}`;
    const headers = {
        'Authorization': `token ${githubApiKey}`, // Replace with your GitHub token
        'Accept': 'application/vnd.github.v3+json'
    };
    const commitsResponse = await fetch(commitsUrl, { headers });
    const commits = await commitsResponse.json();
    const commitCount = commits.length;

    return {
        path: filePath,
        fileContent,
        lineCount,
        commitCount
    };
}

async function getAllFilesInRepo(repoUrl) {
    async function fetchAllFiles(path = '') {
        const contents = await fetchRepoContents(repoUrl, path);
        let files = [];

        for (const item of contents) {
            if (item.type === 'file') {
                const metadata = await getFileMetadata(repoUrl, item.path);
                files.push(metadata);
            } else if (item.type === 'dir') {
                const dirFiles = await fetchAllFiles(item.path);
                files = files.concat(dirFiles);
            }
        }

        return files;
    }

    return await fetchAllFiles();
}

function indent(str, indent = '    ') {
    return str.split('\n').map(line => indent + line).join('\n');
}

async function aiDetermineHumanFiles(filenames) {
    const { object } = await generateObject({
        model: aiModel,
        schema: z.object({
            filenamesForHumanEditedFiles: z.array(z.string()),
        }),
        prompt: 'Given a list of filenames in a code project, determine the files that were edited by a human. Things like package.json, build files, any vendored dependencies, and generated code should be excluded. The goal is to determine the files that were written by a human coder. Provide a list of filenames that were edited by a human coder. Filenames: ' + JSON.stringify(filenames)
    })

    return object.filenamesForHumanEditedFiles
}

async function aiDetermineIfShipped(projectDetails) {
    const { object } = await generateObject({
        model: aiModel,
        schema: z.object({
            isShipped: z.boolean(),
            isShippedReasoning: z.string(),
        }),
        prompt: `Determine if this project has been shipped:

1. Does this project look like it's still WIP?
2. Is this project experienceable by other people, meaning they can follow instructions and run it on their own computer (either in their browser or in their CLI)? If there is a live URL somewhere, then this is almost definitely a yes

Be generous with your determination, and if in down return YES.

${projectDetails}`
    })

    return object
}

async function aiEstimateCodeTime(codeDiff) {
    async function call() {
        return generateObject({
            model: aiModel,
            schema: z.object({
                breakdown: z.array(z.object({
                    changeTitle: z.string(),
                    changeDescription: z.string(),
                    changeFilenames: z.array(z.string()),
                    percentageOfCodeGenerated: z.number(),
                    percentageOfCodeWrittenByAi: z.number(),
                    estimatedMinutes: z.number(),
                    estimatedMinutesReasoning: z.string(),
                })),
                plagiarismCheckRecommended: z.boolean(),
                totalEstimatedMinutes: z.number(),
            }),
            prompt: `
A coder submitted the following code they claim they wrote to our nonprofit school. Estimate how many minutes it took them to write the code.

Be very strict with estimates. Do not round your estimates. Say 2 minutes instead of 5 minutes if it did not take 5 minutes.

Breakdown changes into 1-4 features implemented / changed (remember, features can span multiple files). Have "% of code generated:", "% of code written with AI:", and "Estimated minutes:" for each section - in that order.

You should understand when 1) they used generators like \`rails g\` or \`npm install --save\` 2) they copy code from StackOverflow, and 3) they use GitHub Copilot. 

Additionally, read through the code and determine if the code might be plagiarized or copied and pasted from somewhere else. Does this look like something a student wrote themselves? Is there any chance it was copied and pasted from somewhere online? It costs us about $3 per plagiarism check, so we only want to do them when they make sense, but we don't want to miss fraud. If the student just ran somethign like \`npx create-next-app@latest\` or \`rails g\`, don't flag them.

${codeDiff}
`.substring(0, 150000) // truncate to 150K characters
        })
    }

    let tries = 5

    while (tries > 0) {
        try {
            let { object } = await call()
            object.model = aiModel.modelId
            object.createdAt = new Date().toISOString()
            console.log(object)

            return object
        } catch (e) {
            console.log(`AI error, retrying ${tries--}...`, e)
        }
    }
}

export function extractCommitUrls(text) {
    const commitUrlRegex = /https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/commit\/([\da-f]+)/g
    return text.match(commitUrlRegex) || []
}

export function extractRepoUrl(text) {
    const repoUrlRegex = /https:\/\/github\.com\/([\w-]+)\/([\w.-]+)/

    let extractedRepoUrl = text.match(repoUrlRegex)

    if (extractedRepoUrl) return extractedRepoUrl[0]
    return null
}

export async function determineIfShipped(repoUrl, scrapbookPostText) {
    console.log("  determineIfShipped: Getting all files in repo")
    let repoFiles = await getAllFilesInRepo(repoUrl)
    console.log("  determineIfShipped: Determining which files are written by a human")
    let filteredRepoFiles = await aiDetermineHumanFiles((repoFiles.map(r => r.path)))

    let readme = repoFiles.find(f => f.path == 'README.md')

    let readmeContents = readme ? readme.fileContent : "No README.md found"
    let projectDetails = `PROJECT_DETAILS

${indent(scrapbookPostText)}

README.md CONTENTS

${indent(readmeContents)}

FILENAMES IN REPO

${filteredRepoFiles.map(f => {
        let repoFile = repoFiles.find(r => r.path == f)

        return indent(`${f} (${repoFile.lineCount} lines, ${repoFile.commitCount} commits)`)
    }).join('\n')}
`

    console.log("  determineIfShipped: Send prompt to AI to determine if shipped")
    return aiDetermineIfShipped(projectDetails)
}

export async function estimateCodeMinutes(commitUrl) {
    let resp = await getCommit(commitUrl)

    console.log(resp)
    let filenames = resp.files.map(f => f.filename)
    let filteredFilenames = await aiDetermineHumanFiles(filenames)

    let toCheckForAi = filteredFilenames.map(n => {
        let file = resp.files.find(f => f.filename === n)
        if (!file) return

        console.log('-------------')
        console.log(file.changes)
        console.log('-------------')

        if (file.changes == 0) return null
        if (!file.patch) return null

        console.log(file)

        let patchWithoutFirstLine = file.patch.split('\n').slice(1).join('\n')

        return `FILENAME: ${n},

    ${patchWithoutFirstLine}
    `
    }).filter(Boolean)

        console.log('-------------')
    console.log(toCheckForAi)
        console.log('-------------')

    if (!toCheckForAi.length) {
        return {
            totalEstimatedMinutes: 0,
            totalEstimatedMinutesReasoning: 'No files to check'
        }
    }

    let prompt = toCheckForAi
        .filter(Boolean) // remove null values
        .join('\n')

    let estimate = await aiEstimateCodeTime(toCheckForAi)
    estimate.commitUrl = commitUrl

    return estimate
}

async function main() {
    while (true) {
        await prompt('Copy the #scrapbook post to the clipboard and hit enter')
        const scrapbookPost = clipboardy.readSync()

        let repoUrl = extractRepoUrl(scrapbookPost)
        if (repoUrl) {
            let result = await determineIfShipped(scrapbookPost)

            console.log(`
${result.isShippedReasoning}

Is shipped?: ${result.isShipped ? 'YES' : 'NO'}
`)
        } else {
            console.log('No GitHub repo URL found in the clipboard text.');
        }

        while (true) {
            const commitUrl = await prompt('Enter the commit URL (write "done" to stop): ')
            if (commitUrl == 'done') break

            let resp = await getCommit(commitUrl)

            let filenames = resp.files.map(f => f.filename)
            let filteredFilenames = await aiDetermineHumanFiles(filenames)

            let toCheckForAi = filteredFilenames.map(n => {
                let file = resp.files.find(f => f.filename === n)

                if (file.changes == 0) return

                let patchWithoutFirstLine = file.patch.split('\n').slice(1).join('\n')

                return `FILENAME: ${n},

    ${patchWithoutFirstLine}
    `
            })
                .filter(Boolean) // remove null values
                .join('\n')

            let estimate = await aiEstimateCodeTime(toCheckForAi)

            console.log(estimate)
//             console.log(`

// Features:
// ${estimate.breakdown.map(b =>
//                 `
//   ${b.estimatedMinutes} minutes: ${b.changeTitle}

//     ${b.changeDescription}

//     Generated: ${b.percentageOfCodeGenerated}%
//     AI: ${b.percentageOfCodeWrittenByAi}%
// `
//             ).join('')}

// Estimate: ${estimate.totalEstimatedMinutes} minutes
// `)
        }
    }

    rl.close()

}
