/*
 * Tests that replica set commands work correctly when the replica set endpoint is used.
 *
 * @tags: [requires_fcv_73, featureFlagEmbeddedRouter, requires_persistence]
 */

import {extractUUIDFromObject} from "jstests/libs/uuid_util.js";
import {
    getReplicaSetURL,
    waitForAutoBootstrap
} from "jstests/noPassthrough/rs_endpoint/lib/util.js";

function runTests(shard0Primary, tearDownFunc, isMultitenant) {
    jsTest.log("Running tests for " + shard0Primary.host +
               " while the cluster contains one shard (config shard)");

    const res0 = assert.commandWorked(shard0Primary.adminCommand({hello: 1}));
    assert(res0.isWritablePrimary, res0);

    assert.commandWorked(
        shard0Primary.adminCommand({replSetStepDown: ReplSetTest.kForeverSecs, force: true}));
    const res1 = assert.commandWorked(shard0Primary.adminCommand({hello: 1}));
    assert(!res1.isWritablePrimary, res1);

    assert.commandWorked(shard0Primary.adminCommand({replSetFreeze: 0}));
    assert.commandWorked(shard0Primary.adminCommand({replSetStepUp: 1}));
    assert.soon(() => {
        const res2 = assert.commandWorked(shard0Primary.adminCommand({hello: 1}));
        return res2.isWritablePrimary;
    });

    if (isMultitenant) {
        // Currently, sharding isn't supported in serverless. So the cluster cannot become
        // multi-shard.
        tearDownFunc();
        return;
    }

    // Add a second shard to the cluster.
    const shard1Name = "shard1-" + extractUUIDFromObject(UUID());
    const shard1Rst = new ReplSetTest({name: shard1Name, nodes: 2});
    shard1Rst.startSet({shardsvr: ""});
    shard1Rst.initiate();
    const shard1Primary = shard1Rst.getPrimary();

    // Run the addShard command against shard0's primary mongod instead to verify that
    // replica set endpoint supports router commands.
    assert.commandWorked(
        shard0Primary.adminCommand({addShard: shard1Rst.getURL(), name: shard1Name}));

    jsTest.log("Running tests for " + shard0Primary.host +
               " while the cluster contains two shards (one config shard and one regular shard)");

    // TODO (SERVER-83380): Connect to the router port on a shardsvr mongod instead.
    const shard0URL = getReplicaSetURL(shard0Primary);
    const mongos = MongoRunner.runMongos({configdb: shard0URL});
    assert.commandFailedWithCode(mongos.adminCommand({replSetStepDown: 1, force: true}),
                                 ErrorCodes.CommandNotFound);

    assert.commandWorked(shard0Primary.adminCommand({replSetStepDown: 1, force: true}));
    const res3 = assert.commandWorked(shard0Primary.adminCommand({hello: 1}));
    assert(!res3.isWritablePrimary, res3);

    // Verify that the primary on shard1 hasn't changed.
    assert.eq(shard1Primary, shard1Rst.getPrimary());

    tearDownFunc();
    shard1Rst.stopSet();
    MongoRunner.stopMongos(mongos);
}

{
    jsTest.log("Running tests for a standalone bootstrapped as a single-shard cluster");
    const node = MongoRunner.runMongod({
        setParameter: {featureFlagAllMongodsAreSharded: true, featureFlagReplicaSetEndpoint: true},
    });
    const tearDownFunc = () => MongoRunner.stopMongod(node);

    waitForAutoBootstrap(node);
    runTests(node /* shard0Primary */, tearDownFunc);
}

{
    jsTest.log("Running tests for a replica set bootstrapped as a single-shard cluster");
    const rst = new ReplSetTest({
        nodes: 2,
        nodeOptions: {
            setParameter: {
                featureFlagAllMongodsAreSharded: true,
                featureFlagReplicaSetEndpoint: true,
            }
        },
        useAutoBootstrapProcedure: true,
    });
    rst.startSet();
    rst.initiate();
    const primary = rst.getPrimary();
    const tearDownFunc = () => rst.stopSet();

    waitForAutoBootstrap(primary);
    runTests(primary /* shard0Primary */, tearDownFunc);
}

// TODO (SERVER-81968): Re-enable single-shard cluster test cases once config shards support
// embedded routers.
// {
//     jsTest.log("Running tests for a single-shard cluster");
//     const st = new ShardingTest({
//         shards: 1,
//         rs: {nodes: 2, setParameter: {featureFlagReplicaSetEndpoint: true}},
//         configShard: true,
//     });
//     const tearDownFunc = () => st.stop();

//     runTests(st.rs0.getPrimary() /* shard0Primary */, tearDownFunc);
// }

{
    jsTest.log("Running tests for a serverless replica set bootstrapped as a single-shard cluster");
    const rst = new ReplSetTest({
        name: jsTest.name() + "_multitenant",
        nodes: 2,
        nodeOptions: {
            setParameter: {
                featureFlagAllMongodsAreSharded: true,
                featureFlagReplicaSetEndpoint: true,
                multitenancySupport: true
            }
        },
    });
    rst.startSet();
    rst.initiate();
    const primary = rst.getPrimary();
    const tearDownFunc = () => rst.stopSet();

    waitForAutoBootstrap(primary);
    runTests(primary /* shard0Primary */, tearDownFunc, true /* isMultitenant */);
}
