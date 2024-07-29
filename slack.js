import 'chromedriver'
import webdriver, { By, until } from 'selenium-webdriver'
import fs from 'fs'
import { prompt, promptConfirm, wait } from './util.js'
import { determineIfShipped, estimateCodeMinutes, extractCommitUrls, extractRepoUrl } from './index.js'

const seleniumStatePath = 'selenium-state.json'

async function loadState(driver) {
    if (fs.existsSync(seleniumStatePath)) {
        const state = JSON.parse(fs.readFileSync(seleniumStatePath, 'utf-8'));

        // Load cookies
        if (state.cookies) {
            for (const cookie of state.cookies) {
                await driver.manage().addCookie(cookie);
            }
        }

        // Load local storage
        if (state.localstorage) {
            await driver.executeScript('window.localStorage.clear();');
            for (const [key, value] of Object.entries(state.localstorage)) {
                await driver.executeScript(`window.localStorage.setItem(arguments[0], arguments[1]);`, key, value);
            }
        }
    }
}

async function saveState(driver) {
    let state = {};

    state.cookies = await driver.manage().getCookies();
    state.localstorage = await driver.executeScript('return {...window.localStorage};');

    fs.writeFileSync(seleniumStatePath, JSON.stringify(state, null, 2));
}

async function findElementsByText(driver, text) {
    return driver.findElements(By.xpath(`//*[contains(text(), '${text}')]`));
}

async function waitForTexts(driver, texts, timeout = 600000) {
    await driver.wait(async () => {
        for (const text of texts) {
            const elements = await findElementsByText(driver, text)
            if (elements.length === 0) {
                return false;
            }
        }
        return true;
    }, timeout);
}

let driver = new webdriver.Builder().forBrowser('chrome').build();

try {
    await driver.get('https://hackclub.slack.com')

    // load saved cookies / localstorage to authenticate
    await loadState(driver)
    await driver.navigate().refresh()

    await driver.get('https://app.slack.com/client/T0266FRGM/C07A3UVH2A3')

    while (true) {
        await waitForTexts(driver, ['Is this project a ship?', 'Yes (Shipped)', 'No (WIP)'])

        console.log('Review detected!')

        let sidebar = await driver.findElement(By.className('c-message_kit__gutter__right'))

        let scrapbookPostText = await sidebar.getText()

        let repoUrl = extractRepoUrl(scrapbookPostText)

        if (repoUrl) {
            console.log('Using AI to determine if shipped...')
            let result = await determineIfShipped(repoUrl, scrapbookPostText)

            console.log(`
${result.isShippedReasoning}

(Recommendation): Is shipped?: ${result.isShipped ? 'YES' : 'NO'}
`)

            let markShipped = await promptConfirm('Mark #scrapbook post as shipped?')

            if (markShipped) {
                let btn = await findElementsByText(driver, 'Yes (Shipped)')
                await btn[0].click()
            } else {
                let btn = await findElementsByText(driver, 'No (WIP)')
                await btn[0].click()
            }
        } else {
            console.log('No GitHub repo URL found in the #scrapbook post.');
        }

        await waitForTexts(driver, ['open in slack', 'override on airtable'])

        // there are 3 bars - channel list, messages list, and thread sidebar
        let verticalSlackBars = await driver.findElements(By.xpath("//*[@data-qa='slack_kit_list']"))

        let threadSidebar
        for (let b of verticalSlackBars) {
            let text = await b.getText()
            if (text.includes("hey hey! it's time to review your arcade session!!")) {
                threadSidebar = b
                break
            }
        }

        while (true) {
            let visibleMessages = await threadSidebar.findElements(By.xpath("//*[@role='listitem']"))

            let firstMessageForSessionToReview
            for (let m of visibleMessages) {
                let text = await m.getText();
                if (text.includes('hakkuun') && text.includes('minutes') && text.includes('approve') && text.includes('reject') && text.includes('open in slack') && text.includes('override on airtable')) {
                    firstMessageForSessionToReview = m;
                    break;
                }
            }

            if (!firstMessageForSessionToReview) {
                
                await promptConfirm('No more sessions to review. Hit enter for next review to start:')

                break
            }

            await driver.executeScript('arguments[0].scrollIntoView()', firstMessageForSessionToReview)

            // if the message is long, there will be a "see more" button. click it to expand the message
            let seeMore = await findElementsByText(driver, 'See more')
            if (seeMore.length > 0) {
                await seeMore[0].click()
                await wait(500)
            }

            console.log('MESSAGE TO REVIEW')
            console.log('----------------------')
            console.log(await firstMessageForSessionToReview.getText())

            let commitUrls = extractCommitUrls(await firstMessageForSessionToReview.getText())

            console.log('\n\nCommit URLs:\n' + commitUrls.join('\n'))
            console.log()

            let estimates = await Promise.all(commitUrls.map(async url => estimateCodeMinutes(url)))

            let estimatedMinutes = estimates.reduce((sum, e) => sum + e.totalEstimatedMinutes, 0)
            let plagiarismCheckRecommended = estimates.filter(e => e.plagiarismCheckRecommended)

            console.log()
            console.log()
            console.log(JSON.stringify(estimates, null, 2))
            console.log()
            console.log()
            plagiarismCheckRecommended.forEach(e => console.log('Plagiarism check recommended for ', e.commitUrl))
            console.log()
            console.log('Estimated minutes: ' + estimatedMinutes)
            console.log()

            let action = (await prompt({
                type: 'list',
                name: 'result',
                message: 'Approve the session?',
                choices: [
                    { name: 'Approve', value: 'approve' },
                    { name: 'Reject', value: 'reject' },
                    { name: 'Reject (Lock)', value: 'reject-lock' },
                    { name: 'See code', value: 'see-code' },
                ]
            })).result

            async function getBtn(txt) {
                let btns = await firstMessageForSessionToReview.findElements(By.css('.p-block_kit_button_element'))
                for (let btn of btns) {
                    let btnText = await btn.getText()
                    if (btnText.includes(txt)) {
                        return btn
                    }
                }
                return null
            }

            if (action == 'approve') {
                let btn = await getBtn('approve')
                await btn.click()

            } else if (action == 'reject') {
                let btn = await getBtn('reject')
                await btn.click()
            } else if (action == 'reject-lock') {
                let btn = await getBtn('reject & lock')
                await btn.click()
            }

            await driver.wait(until.elementTextContains(firstMessageForSessionToReview, 'undo'), 60000);
        }
    }

    await waitForTexts(driver, ['alsdkfjaklsdfj'])
} finally {
    await saveState(driver)
    await driver.quit()
}