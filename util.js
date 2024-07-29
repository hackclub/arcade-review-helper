import inquirer from 'inquirer'

export async function prompt(question) {
    let q

    if (typeof question === 'string') {
        q = {
            type: 'input',
            name: 'result',
            message: question
        }
    } else {
        q = question
    }

    let res = await inquirer.prompt(q)

    if (typeof question === 'string') {
        return res.result
    } else {
        return res
    }
}

export async function promptConfirm(question) {
    return (await prompt({
        type: 'confirm',
        name: 'result',
        message: question
    })).result
}

export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}