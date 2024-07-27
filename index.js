import readline from 'readline'
import clipboardy from 'clipboardy'

// load .env
require('dotenv').config()

const githubApiKey = process.env.GITHUB_API_KEY
const toIgnore = [
    /Cargo/,
    /node_modules/,
    /package.json/,
    /bun.lockb/,
    /LICENSE/,
    /.png$/,
    /.jpg$/,
    /.jpeg$/,
    /.pyc$/,
    /.ipynb$/,
    /Pipfile/,
    /.csv$/
]

async function getCommit(commitUrl) {
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

    try {
        const response = await fetch(apiUrl, { headers });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return response.json()
    } catch (error) {
        console.error('Error fetching commit diff:', error);
    }
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

function filterOut(strings, regexes) {
    return strings.filter(s => {
        return !regexes.some(r => r.test(s))
    })
}

function indent(str, indent = '    ') {
    return str.split('\n').map(line => indent + line).join('\n');
}

function prompt(rl, query) {
    return new Promise(resolve => rl.question(query, resolve))
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

while (true) {
    await prompt(rl, 'Copy the #scrapbook post to the clipboard and hit enter')
    const scrapbookPost = clipboardy.readSync()

    const repoUrlRegex = /https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/;
    const extractedRepoUrl = scrapbookPost.match(repoUrlRegex);
    if (extractedRepoUrl) {
        console.log('Extracted GitHub repo URL:', extractedRepoUrl[0]);

        let repoFiles = await getAllFilesInRepo(extractedRepoUrl[0])
        let filteredRepoFiles = filterOut(repoFiles.map(r => r.path), toIgnore)

        let readme = repoFiles.find(f => f.path === 'README.md')

        let readmeContents = readme ? readme.fileContent : "No README.md found"

        let isShippedPrompt = `Determine if this project has been shipped:

1. Is this project complete?
2. Is this project experienceable by other people, meaning they can follow instructions and run it on their own computer (either in their browser or in their CLI)? If there is a live URL somewhere, then this is almost definitely a yes

PROJECT_DETAILS

${indent(scrapbookPost)}

README.md CONTENTS

${indent(readmeContents)}

FILENAMES IN REPO

${filteredRepoFiles.map(f => {
            let repoFile = repoFiles.find(r => r.path == f)

            return indent(`${f} (${repoFile.lineCount} lines, ${repoFile.commitCount} commits)`)
        }).join('\n')}
`

        console.log(isShippedPrompt)
        clipboardy.writeSync(isShippedPrompt)
    } else {
        console.log('No GitHub repo URL found in the clipboard text.');
    }

    while (true) {
        const commitUrl = await prompt(rl, 'Enter the commit URL (write "done" to stop): ')
        if (commitUrl == 'done') break

        let resp = await getCommit(commitUrl)

        let filenames = resp.files.map(f => f.filename)
        let filteredFilenames = filterOut(filenames, toIgnore)

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

        let promptForCodeTimeEstimate = `A coder submitted the following diffs. Estimate how many minutes it took them to make these changes. You are an expert coder, so you should understand when they used generators like \`rails g\` or \`npm install --save\` and estimate appropriately.

    ${toCheckForAi}`

        console.log(promptForCodeTimeEstimate)
        clipboardy.writeSync(promptForCodeTimeEstimate)
    }
}

rl.close()