#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

// ─── Configuración ────────────────────────────────────────────────────────────

const API_URL = 'https://copuchat.latamgpt.org/api/chat';
const SESSION_ID = randomUUID();

// ─── API: enviar mensaje con streaming SSE ────────────────────────────────────

async function sendMessage(messages, { temperature = 0.2, topP = 1, raw = false } = {}) {
    const payload = {
        messages: messages.map((m, i) => ({
            id: m.id || randomUUID(),
            role: m.role,
            content: m.content,
            timestamp: m.timestamp || new Date().toISOString(),
            messageIndex: i,
        })),
        temperature,
        topP,
        sessionId: SESSION_ID,
        conversationId: `${SESSION_ID}_${new Date().toISOString().split('T')[0]}`,
    };

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        throw new Error(`Error HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    if (!raw) {
        process.stdout.write(chalk.magenta('❯ '));
    }

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
                if (!raw) process.stdout.write('\n');
                return fullText;
            }

            try {
                const parsed = JSON.parse(data);
                if (parsed.error) throw new Error(parsed.error);
                if (parsed.content) {
                    fullText += parsed.content;
                    process.stdout.write(raw ? parsed.content : chalk.white(parsed.content));
                }
            } catch (e) {
                if (e.message && !e.message.includes('JSON')) throw e;
            }
        }
    }

    if (!raw) process.stdout.write('\n');
    return fullText;
}

// ─── Modo interactivo (REPL) ──────────────────────────────────────────────────

async function interactiveMode(opts) {
    const history = [];

    console.log(chalk.magenta.bold('\n  ╔═══════════════════════════════════════╗'));
    console.log(chalk.magenta.bold('  ║') + chalk.white.bold('     CopuChat CLI — LatamGPT           ') + chalk.magenta.bold('║'));
    console.log(chalk.magenta.bold('  ╚═══════════════════════════════════════╝'));
    console.log(chalk.gray(`  Modelo: GPT-4.1 Mini | Temp: ${opts.temperature} | Top-p: ${opts.topP}`));
    console.log(chalk.gray('  Escribe "salir" o presiona Ctrl+C para terminar.\n'));

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.cyan.bold('Tú: '),
    });

    rl.prompt();

    for await (const line of rl) {
        const input = line.trim();
        if (!input) { rl.prompt(); continue; }

        if (['salir', 'exit', 'quit', '/q'].includes(input.toLowerCase())) {
            console.log(chalk.gray('\n¡Hasta pronto! 👋\n'));
            break;
        }

        history.push({ role: 'user', content: input });

        try {
            process.stdout.write(chalk.magenta.bold('Bot: '));
            const response = await sendMessage(history, { ...opts, raw: true });
            process.stdout.write('\n');
            history.push({ role: 'assistant', content: response });
        } catch (err) {
            console.error(chalk.red(`\n✗ Error: ${err.message}`));
            history.pop();
        }

        console.log();
        rl.prompt();
    }

    process.exit(0);
}

// ─── Leer stdin (modo pipe) ───────────────────────────────────────────────────

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => resolve(data.trim()));
        process.stdin.on('error', reject);
        // Timeout por si stdin no termina (e.g. terminal normal)
        setTimeout(() => resolve(data.trim()), 500);
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
    .scriptName('copuchat')
    .usage('Uso: $0 [opciones] [mensaje...]')
    .option('interactive', {
        alias: 'i',
        type: 'boolean',
        default: false,
        describe: 'Modo conversación interactiva (REPL)',
    })
    .option('temperature', {
        alias: 't',
        type: 'number',
        default: 0.2,
        describe: 'Temperatura del modelo (0 = determinista, 1 = creativo)',
    })
    .option('top-p', {
        alias: 'p',
        type: 'number',
        default: 1,
        describe: 'Top-p sampling (0 = enfocado, 1 = diverso)',
    })
    .option('raw', {
        alias: 'r',
        type: 'boolean',
        default: false,
        describe: 'Solo imprimir la respuesta sin formato (ideal para pipes)',
    })
    .example('$0 "¿Qué es LatamGPT?"', 'Enviar un mensaje directo')
    .example('$0 -i', 'Iniciar chat interactivo')
    .example('$0 -i -t 0.8', 'Chat interactivo con temperatura alta')
    .example('echo "Hola" | $0 --raw', 'Usar desde un pipe')
    .epilogue('CopuChat — Recolección de datos para LatamGPT\nhttps://copuchat.latamgpt.org')
    .help()
    .version('1.0.0')
    .strict(false)
    .parseSync();

async function main() {
    const opts = {
        temperature: argv.temperature,
        topP: argv.topP,
        raw: argv.raw,
    };

    // Modo interactivo
    if (argv.interactive) {
        await interactiveMode(opts);
        return;
    }

    // Mensaje directo desde argumentos (todo lo que no sea una opción)
    const directMessage = argv._.join(' ').trim();
    if (directMessage) {
        try {
            await sendMessage([{ role: 'user', content: directMessage }], opts);
        } catch (err) {
            console.error(chalk.red(`✗ Error: ${err.message}`));
            process.exit(1);
        }
        return;
    }

    // Modo pipe: si stdin no es una terminal, leer de stdin
    if (!process.stdin.isTTY) {
        try {
            const input = await readStdin();
            if (input) {
                await sendMessage([{ role: 'user', content: input }], opts);
                return;
            }
        } catch (err) {
            console.error(chalk.red(`✗ Error: ${err.message}`));
            process.exit(1);
        }
    }

    // Sin argumentos: mostrar ayuda
    console.log(chalk.yellow('No se proporcionó un mensaje. Usa --help para ver opciones, o -i para modo interactivo.\n'));
    yargs(hideBin(process.argv))
        .scriptName('copuchat')
        .usage('Uso: $0 [opciones] [mensaje...]')
        .option('interactive', { alias: 'i', type: 'boolean', describe: 'Modo conversación interactiva' })
        .option('temperature', { alias: 't', type: 'number', describe: 'Temperatura (0-1)' })
        .option('top-p', { alias: 'p', type: 'number', describe: 'Top-p (0-1)' })
        .option('raw', { alias: 'r', type: 'boolean', describe: 'Solo respuesta sin formato' })
        .showHelp();
}

main().catch(err => {
    console.error(chalk.red(`✗ Error fatal: ${err.message}`));
    process.exit(1);
});
