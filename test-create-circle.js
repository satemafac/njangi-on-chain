import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import fs from 'fs';

async function main() {
  // Connect to Sui testnet
  const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
  
  // Load your local keypair
  const privateKeyHex = fs.readFileSync('./dev-key.txt', 'utf8').trim();
  const keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKeyHex, 'hex'));
  const address = keypair.getPublicKey().toSuiAddress();
  
  console.log(`Using address: ${address}`);
  
  // Create transaction block
  const txb = new TransactionBlock();
  
  // Create a small circle to test
  txb.moveCall({
    target: `0x20cc18715122dbdf12a00b97fdda80f60c3ccbf0b83ab3a78d80f3c0bf4e5ff7::njangi_circle::create_circle`,
    arguments: [
      txb.pure.string("Test Circle"),           // name
      txb.pure.u64("10000000"),                 // contribution_amount (small amount)
      txb.pure.u64("5000000"),                  // security_deposit
      txb.pure.u64(0),                          // cycle_length (weekly)
      txb.pure.u64(1),                          // cycle_day (Monday)
      txb.pure.u8(0),                           // circle_type (rotational)
      txb.pure.u64(3),                          // max_members
      txb.pure.u8(0),                           // rotation_style
      txb.pure.vector(Array(2).fill(false), 'bool'), // penalty_rules
      txb.pure.option(null, 'u8'),              // goal_type (none)
      txb.pure.option(null, 'u64'),             // target_amount
      txb.pure.option(null, 'u64'),             // target_date
      txb.pure.bool(false),                     // verification_required
      txb.object('0x6'),                        // clock object
    ]
  });
  
  // Sign and execute
  try {
    const result = await suiClient.signAndExecuteTransactionBlock({
      signer: keypair,
      transactionBlock: txb,
      options: {
        showEffects: true,
        showEvents: true,
      }
    });
    
    console.log("Transaction successful!");
    console.log("Digest:", result.digest);
    console.log("Status:", result.effects?.status?.status);
    
    // Print events
    if (result.events && result.events.length > 0) {
      console.log("\nEvents:");
      result.events.forEach(event => {
        console.log(JSON.stringify(event, null, 2));
      });
    }
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

main().catch(console.error); 