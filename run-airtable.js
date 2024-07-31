import Airtable from 'airtable'
import PQueue  from 'p-queue'

// load .env
import 'dotenv/config'
import { estimateCodeMinutes, extractCommitUrls, getCommit } from '.'

let base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)

const queue = new PQueue({ concurrency: 10 })

await base('Sessions').select({
    filterByFormula: 'AND({Zach - Temp - Do AI Review} = TRUE(), {Zach - Temp - AI Review} = BLANK())'
}).eachPage((records, fetchNextPage) => {
    records.forEach(s => {
        queue.add(async () => {
            console.log(s.get('User: Name')[0] + "'s session")

            let commitText = s.get('Git commits') || ''

            let commitUrls = extractCommitUrls(commitText)
            commitUrls = await Promise.all(commitUrls.map(async url => {
                try {
                    await getCommit(url) // making sure commit doesn't 404
                    return url
                } catch (error) {
                    return null
                }
            }))
            commitUrls = commitUrls.filter(url => url !== null)

            if (!commitUrls.length) {
                console.log('  No valid commit URLs found in the Airtable record.')
                return
            }


            let estimates = await Promise.all(commitUrls.map(async url => {
                console.log('  AI estimating minutes for ' + url)
                return estimateCodeMinutes(url)
            }))

            let aiAnalysis = {
                estimates,
                grandTotalEstimatedMinutes: estimates.reduce((sum, e) => sum + e.totalEstimatedMinutes, 0),
                grantTotalPlagiarismCheckRecommended: estimates.some(e => e.plagiarismCheckRecommended)
            }

            console.log('  Write result to Airtable')

            await base('Sessions').update(s.id, {
                'Zach - Temp - AI Review': JSON.stringify(aiAnalysis, null, 2),
                'Zach - Temp - AI Thinks Plagiarism?': aiAnalysis.grantTotalPlagiarismCheckRecommended,
                'Zach - Temp - AI Minutes Estimate': aiAnalysis.grandTotalEstimatedMinutes
            })

            console.log(aiAnalysis)
        })
    })

    fetchNextPage()
})