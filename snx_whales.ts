import fs from 'fs';
import path from 'path';

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const path_memes_long = path.resolve(__dirname, `./data/whale_memes_long.txt`);
const path_memes_short = path.resolve(__dirname, `./data/whale_memes_short.txt`);

import dotenv from 'dotenv';
dotenv.config();

// import { client } from './client'
// // import { abi } from './abi'

import { ethers, Contract } from 'ethers';
import contracts from './node_modules/synthetix/publish/deployed/mainnet-ovm/deployment.json';

// https://github.com/Synthetixio/synthetix/blob/bf9d09d9d4d6d4222aaf4501592d602edf9e302d/contracts/PerpsV2MarketProxyable.sol#LL292C20-L292C106
// keccak256("PositionModified(uint256,address,uint256,int256,int256,uint256,uint256,uint256,int256)")
const positionModifiedHash = '0xc0d933baa356386a245ade48f9a9c59db4612af2b5b9c17de5b451c628760f43';

const eventABI = [
    'event PositionModified(uint256 indexed id, address indexed account, uint256 margin, int256 size, int256 tradeSize, uint256 lastPrice, uint256 fundingIndex, uint256 fee, int256 skew)',
];

const providerOE = new ethers.providers.WebSocketProvider(process.env.API_KEY_OE_MAINNET || '');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY ?? '', providerOE);

import { TwitterApi } from 'twitter-api-v2';

const appKey = process.env.TWITTER_API_KEY_SNX ?? '';
const appSecret = process.env.TWITTER_API_SECRET_SNX ?? '';
const accessToken = process.env.TWITTER_ACCESS_TOKEN_SNX ?? '';
const accessSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET_SNX ?? '';

const twitter = new TwitterApi({
    appKey: appKey,
    appSecret: appSecret,
    accessToken: accessToken,
    accessSecret: accessSecret,
});

async function getMarkets() {
    const managerABI = contracts.sources.FuturesMarketManager.abi;
    const managerAddr = contracts.targets.FuturesMarketManager.address;
    const manager = new ethers.Contract(managerAddr, managerABI, providerOE);

    // overloaded function names need signature in ethers
    const markets = await manager['allMarkets(bool)'](true);
    return markets.map((address: string) => new ethers.Contract(address, eventABI, signer));
}

async function getMarketSymbols() {
    const marketSymbols = new Map();
    const perpsV2MarketABI = contracts.sources.PerpsV2Market.abi;

    let targets = Object.entries(contracts.targets);
    for (let i = 0; i < targets.length; i++) {
        if (
            targets[i][1]['source'].includes('PerpsV2Market') &&
            targets[i][1]['source'] != 'PerpsV2MarketData' &&
            targets[i][1]['source'] != 'PerpsV2MarketSettings' &&
            targets[i][1]['source'] != 'PerpsV2MarketState' &&
            targets[i][1]['source'] != 'PerpsV2MarketViews' &&
            targets[i][1]['source'] != 'PerpsV2MarketDelayedOrders' &&
            targets[i][1]['source'] != 'PerpsV2MarketDelayedOrdersOffchain' &&
            targets[i][1]['source'] != 'PerpsV2MarketDelayedIntent' &&
            targets[i][1]['source'] != 'PerpsV2MarketDelayedExecution' &&
            targets[i][1]['source'] != 'PerpsV2MarketLiquidate'
        ) {
            const perpsV2Market = new ethers.Contract(
                targets[i][1]['address'],
                perpsV2MarketABI,
                signer
            );
            const parentAddress = await perpsV2Market.proxy();

            marketSymbols.set(
                parentAddress,
                '$'.concat(
                    '',
                    targets[i][1]['name'].replace('PerpsV2Market', '').replace('PERP', '')
                )
            );
        }
    }
    return marketSymbols;
}

type Positions = {
    account: string;
    marketSymbol: string;
    tradeSize: string;
    type: string;
    lastPrice: string;
    value: number;
};

function makeFloat(input: string) {
    return parseFloat(ethers.utils.formatEther(ethers.BigNumber.from(input)));
}

function loadMemes(path_memes: string) {
    const memeFile = fs.readFileSync(path_memes, { flag: 'r+' });
    return memeFile.toString().replace(/\r\n/g, '\n').split('\n');
}

function getFlavorText(position: Positions) {
    let memes;
    if (position.type == 'LONG') {
        memes = loadMemes(path_memes_long);
    } else {
        memes = loadMemes(path_memes_short);
    }
    let memeIndex = Math.floor(Math.random() * memes.length);

    return memes[memeIndex];
}

function getTweet(position: Positions) {
    let dollarUSLocale = Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        useGrouping: false,
    });

    let flavorText = getFlavorText(position);
    let tweet =
        position.type +
        ' ' +
        ethers.utils.formatEther(ethers.BigNumber.from(position.tradeSize)).substring(0, 7) +
        ' ' +
        position.marketSymbol +
        ' @ ' +
        dollarUSLocale.format(makeFloat(position.lastPrice)) +
        '\n\n' +
        flavorText +
        '\n\n' +
        'https://watcher.synthetix.io/' +
        position.account;

    return tweet;
}

enum mutex {
    Locked = 1,
    Unlocked,
}

const tweetBuffer: string[] = [];
let tweetBufferMutex: mutex = mutex.Unlocked;

const addToTweetBuffer = async (tweet: string) => {
    while (tweetBufferMutex == mutex.Locked) {
        await delay(1000);
    }
    tweetBufferMutex = mutex.Locked;
    tweetBuffer.push(tweet);
    console.log('added tweet:', tweet);
    tweetBufferMutex = mutex.Unlocked;
};

const publishFromTweetBuffer = async () => {
    tweetBufferMutex = mutex.Locked;
    while (tweetBuffer.length > 0) {
        try {
            let tweet = tweetBuffer.shift();
            if (tweet) {
                console.log('posted tweet:', tweet);
                twitter.v2.tweet(tweet);
            }
        } catch (e) {
            console.log(
                new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '') +
                    ' publishFromTweetBuffer:' +
                    e
            );
        }
        await delay(1000);
    }
    tweetBufferMutex = mutex.Unlocked;
};

async function main() {
    console.log('Refreshing Markets');
    const markets: Contract[] = await getMarkets();
    const marketSymbols = await getMarketSymbols();

    for (const market of markets) {
        const filterPosition = {
            address: market.address,
            topics: [
                ethers.utils.id(
                    'PositionModified(uint256,address,uint256,int256,int256,uint256,uint256,uint256,int256)'
                ),
            ],
        };

        market.on(
            filterPosition,
            async (
                id,
                account,
                margin,
                size,
                tradeSize,
                lastPrice,
                fundingIndex,
                fee,
                skew,
                event
            ) => {
                const position = {
                    account: account,
                    marketSymbol: marketSymbols.get(market.address),
                    tradeSize: tradeSize.toString().replace('-', ''),
                    type: makeFloat(tradeSize) > 0 ? 'LONG' : 'SHORT',
                    lastPrice: lastPrice.toString(),
                    value:
                        parseFloat(
                            ethers.utils.formatEther(tradeSize.toString().replace('-', ''))
                        ) * parseFloat(ethers.utils.formatEther(lastPrice.toString())),
                };

                if (position.value >= 1000000.0) {
                    addToTweetBuffer(getTweet(position));
                    publishFromTweetBuffer();
                }
            }
        );

        console.log(
            `Listening for ${marketSymbols.get(market.address)} whales on contract ${
                market.address
            }`
        );
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
