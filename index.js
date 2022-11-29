/**
 * DSP Latency Test
 *   version 1.3 (26 Nov 2022)
 *
 * License: https://www.upwork.com/legal#optional-service-contract-terms
 *
 * Owner: Derek Maxson, Front Porch
 * Author: Alexander Mokrov
 *
 * Usage:
 *   node index.js --dspIP=1.2.3.4 --domainsFile=./domain-list.txt --IPsFile=./ip-list.txt --MPS=100 --test_duration=5
 */


const zmq = require("zeromq");
const cla = require("command-line-args");
const fs = require("fs");


// Parse command line arguments
const clOptions = [
    { name: 'domainsFile', type: String },  // domains list file
    { name: 'IPsFile', type: String },  // IP list file
    { name: 'MPS', type: Number, defaultValue: 30000 },  // queries per second (rate)
    { name: 'dspIP', alias: 'd', type: String, defaultValue: '*' },  // IP address of the DSP
    { name: 'rcvport', alias: 'r', type: Number, defaultValue: 58505 },  // "Receive from" port
    { name: 'sndport', alias: 's', type: Number, defaultValue: 58501 },  // "Send to" port
    { name: 'test_duration', type: Number, defaultValue: 60 },  // Test duration in seconds
    { name: 'verbose', alias: 'v', type: Boolean, defaultValue: false }  // Print debug info
];

const options = cla(clOptions);

if (options.verbose) {
    console.log('DSP Latency Test started with command line options:');
    console.log(options);
}


/**
 * Load text file as array of lines, filter empty
 */
function getListFromTextFile(filename) {
    return new Promise(resolve => {
        fs.readFile(filename, 'utf8', function(err, data) {
            if (err) throw err;
            var items = data.split(/\r?\n/);
            items = items.filter(item => item != '');
            resolve(items);
        });
    });
}

let senderSocket, receiverSocket;

// total number of messages
let msgs = options.test_duration * options.MPS;

// request start and end times and count
let reqStartTime = {};
let reqEndTime = {};
let pendingCount = 0;

// counters for sent and received messages
let msgsSent = 0, msgsReceived = 0;


/**
 * Calculate difference in microseconds between 2 hrtimes
 */
function uTimeDiff(time0, time1) {
    return (time1[0] - time0[0]) * 1e6 + Math.floor((time1[1] - time0[1]) / 1000);
}


/**
 * Sleep for microseconds (with milliseconds grain)
 */
function uSleep(usec) {
    return new Promise(resolve => {
        setTimeout(resolve, Math.floor(usec / 1000));
    });
}


function encUInt32(uint32) {
    let buf = Buffer.alloc(4, 0);
    buf.writeUInt32BE(uint32, 0);
    return buf;
}


async function main() {
    // set max threads = 2
    zmq.Context.setMaxThreads(2);

    // start threads
    senderThread();
    receiverThread();
}


function statsReport() {
    console.log("# of messages sent: %d", msgsSent);
    console.log("# of messages received: %d", msgsReceived);

    let latencies = [];
    for (let reqID in reqStartTime) {
        if (reqEndTime[reqID] !== undefined) {
            // if (options.verbose)
            //     console.log("Adding latency for ", reqID, reqStartTime[reqID], reqEndTime[reqID]);
            latencies.push(uTimeDiff(reqStartTime[reqID], reqEndTime[reqID]));
        }
    }

    // numeric sort
    latencies.sort((a, b) => a - b);

    // if (options.verbose)
    //     console.log("Latencies: ", latencies);

    let latPercMs = perc => (latencies[Math.round(perc * latencies.length) - 1] / 1000);

    console.log("Max latency: %d ms", latPercMs(1));
    console.log("Percentile 99.9: %d ms", latPercMs(.999));
    console.log("Percentile 99.0: %d ms", latPercMs(.99));
    console.log("Percentile 90.0: %d ms", latPercMs(.90));
}


async function senderThread() {
    // bind send socket
    const sendSocketAddr = 'tcp://' + options.dspIP + ':' + options.sndport;

    console.log("sender thread socket: " + sendSocketAddr);

    senderSocket = zmq.socket("push");
    senderSocket.linger = 1000;  // 1s

    await senderSocket.bind(sendSocketAddr);
    if (options.verbose) console.log('sender thread socket bond');

    var domains = await getListFromTextFile(options.domainsFile);
    if (options.verbose) {
        console.log('Domain list read from ' + options.domainsFile);
        // console.log(domains);
    }

    var ips = await getListFromTextFile(options.IPsFile);
    if (options.verbose) {
        console.log('IP list read from ' + options.IPsFile);
        // console.log(ips);
    }

    console.log("Input data vectors created");
    console.log("# of domains: " + domains.length);
    console.log("# of IPs: " + ips.length);

    const time0 = process.hrtime();  // save start nanotime ([ seconds, nanoseconds ])

    for (var i = 0; i < msgs; i++) {
        // calculate time in microseconds to additionally wait to preserve MPS rate
        // time really spent since start (in microseconds):
        var uTimeSpent = uTimeDiff(time0, process.hrtime());
        // if (options.verbose) console.log("   - really spent usec: " + uTimeSpent);

        // time that we have to spend
        var uTimeReqd = Math.floor(i * 1e6 / options.MPS);
        // if (options.verbose) console.log("   - required     usec: " + uTimeReqd);

        // optional sleep
        if (uTimeReqd > uTimeSpent) {
            await uSleep(uTimeReqd - uTimeSpent);
        }

        // create message
        var reqID = i + 1;
        var randDomain = domains[Math.floor(Math.random() * domains.length)];
        var randIP = ips[Math.floor(Math.random() * ips.length)];

        var msg = [ encUInt32(reqID), randDomain, randIP ];

        if (options.verbose) console.log(" * sending message: ", msg);

        // send message
        await senderSocket.send(msg);

        // save request start time
        reqStartTime[reqID] = process.hrtime();

        msgsSent++; pendingCount++;
    }

    await senderSocket.close();

    // wait up to 10s (receive timeout) for all the replies to be received
    if (options.verbose) console.log("Waiting for the last replies to be received");

    const lastSendTime = process.hrtime();

    while (uTimeDiff(lastSendTime, process.hrtime()) < 10 * 1e6 && pendingCount > 0) {
        await uSleep(100_000);  // sleep 0.1s
    }

    console.log("Test duration: %f s", uTimeDiff(time0, process.hrtime()) / 1e6);

    statsReport();
}


async function receiverThread() {
    // bind receiver socket
    const receiverSocketAddr = 'tcp://' + options.dspIP + ':' + options.rcvport;

    console.log("receiver thread socket: " + receiverSocketAddr);

    receiverSocket = zmq.socket("pull");
    receiverSocket.linger = 1000;  // 1s
    receiverSocket.receiveTimeout = 10000;  // 10s

    await receiverSocket.bind(receiverSocketAddr);
    if (options.verbose) console.log('receiver thread socket bond');

    receiverSocket.on("message", function(rawReqID, rawScore, rawCategory) {
        if (options.verbose) console.log(" * received message: ", rawReqID, rawScore, rawCategory);

        let reqID = rawReqID.readUInt32BE(0);

        // save reply time
        reqEndTime[reqID] = process.hrtime();

        msgsReceived++; pendingCount--;
    });
}

main();

