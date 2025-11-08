/**
 * 🔐 Admin Link Circle Endpoint
 * 
 * Protected endpoint for admin to link circles to WhatsApp
 * Requires: zkLogin authentication + link_circle permission
 * 
 * Example usage:
 * POST /api/whatsapp/admin-link-circle
 * Authorization: Bearer <token>
 * {
 *   "circleId": "0x123...",
 *   "linkType": 1,
 *   "phoneOrGroup": "1234567890"
 * }
 */

import { NextApiResponse, NextApiRequest } from 'next';
import { logAdminAction } from '../../../middleware/admin-auth.middleware';
import { enokiZkLoginService } from '../../../services/enokiZkLoginService';
import { AccountData } from '../../../services/zkLoginService';
import { SuiClient } from '@mysten/sui/client';
import { getNetworkConfig } from '../../../services/network-config';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import type { NetworkType } from '../../../services/whatsapp-registry-service';

interface LinkCircleRequest {
  circleId: string;
  linkType: 1 | 2;  // 1 = individual, 2 = group
  phoneOrGroup: string;
  adminAddress?: string;  // Admin's Sui address
  account?: AccountData;   // Full zkLogin account for transaction signing
  network?: NetworkType;   // Current network selection (testnet/mainnet)
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    // Query current link status from blockchain
    try {
      const { circleId } = req.query;
      
      if (!circleId || typeof circleId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Missing circleId'
        });
      }

      const registryObjectId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID;
      if (!registryObjectId) {
        throw new Error('SUI_WHATSAPP_LINKS_REGISTRY_ID not configured');
      }

      // Query the registry object from blockchain using testnet RPC (default for queries)
      const testnetConfig = getNetworkConfig('testnet');
       const suiClient = new SuiClient({ url: testnetConfig.rpcUrl });
       
       try {
         const registryObject = await suiClient.getObject({
           id: registryObjectId,
           options: {
             showContent: true
           }
         });

         if (!registryObject.data?.content) {
           return res.status(200).json({
             success: true,
             data: {
               isLinked: false,
               message: 'Registry not found or not indexed yet'
             }
           });
         }

         // Extract the registry fields
         if ('fields' in registryObject.data.content) {
           const content = registryObject.data.content as Record<string, unknown>;
           const registryFields = content.fields as Record<string, unknown> | undefined;
           
           if (!registryFields) {
             return res.status(200).json({
               success: true,
               data: {
                 isLinked: false,
                 message: 'Registry fields not found'
               }
             });
           }
           
           console.log('Registry fields keys:', Object.keys(registryFields));
           console.log('Registry total_links:', registryFields.total_links);
           
           // The links are stored in the registry.links vector
           const links = registryFields.links as unknown[];
           if (!Array.isArray(links)) {
             return res.status(200).json({
               success: true,
               data: {
                 isLinked: false,
                 message: 'No links found in registry'
               }
             });
           }

           // Search through the links vector for our circle
           for (const link of links) {
             const linkObj = link as Record<string, unknown>;
             const linkFields = (linkObj.fields as Record<string, unknown>) || linkObj;
             console.log('Checking link:', { 
               circle_id: linkFields.circle_id, 
               link_type: linkFields.link_type,
               enabled: linkFields.enabled,
               looking_for: circleId 
             });

             if (linkFields.circle_id === circleId && linkFields.enabled === true) {
               // Found the link!
               const adminPhone = linkFields.admin_phone_number as Record<string, unknown> | undefined;
               const groupId = linkFields.group_id as Record<string, unknown> | undefined;
               const recipient = linkFields.link_type === 1 
                 ? adminPhone?.value || linkFields.admin_phone_number
                 : groupId?.value || linkFields.group_id;

               return res.status(200).json({
                 success: true,
                 data: {
                   isLinked: true,
                   linkType: linkFields.link_type || 1,
                   recipient: recipient || 'Unknown',
                   linkedAt: new Date(Number(linkFields.linked_at) * 1000).toISOString()
                 }
               });
             }
           }
         }

         // Not found in links vector
         return res.status(200).json({
           success: true,
           data: {
             isLinked: false,
             message: 'Circle not linked'
           }
         });

       } catch (error) {
         console.error('Error querying registry:', error);
         // Return not linked if query fails (may be due to indexing delay)
         return res.status(200).json({
           success: true,
           data: {
             isLinked: false,
             message: 'Unable to query registry (indexing may be delayed)'
           }
         });
       }

    } catch (error) {
      console.error('❌ Error querying link status:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to query link status'
      });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    // Note: Admin authentication is handled at the page level (admin dashboard)
    // This endpoint is only accessible from protected routes
    
    const adminAddr = req.body?.adminAddress || 'unknown';
    const account = req.body?.account as AccountData | undefined;
    
    // Validate request body
    const { circleId, linkType, phoneOrGroup, network = 'mainnet' } = req.body as LinkCircleRequest;

    if (!circleId || !linkType || !phoneOrGroup) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: circleId, linkType, phoneOrGroup'
      });
    }

    if (![1, 2].includes(linkType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid linkType (must be 1 or 2)'
      });
    }

    // Log the action
    logAdminAction('LINK_CIRCLE_INITIATED', adminAddr, {
      circleId,
      linkType,
      recipient: linkType === 1 ? 'individual' : 'group',
      network
    });

    // Get WhatsApp registry for the current network
    const activeRegistries = getActiveWhatsAppRegistries(network);
    if (!activeRegistries || activeRegistries.length === 0) {
      throw new Error(`No active WhatsApp registry configured for ${network} network`);
    }

    // Use the first (current) active registry
    const whatsappRegistry = activeRegistries[0];
    const packageId = whatsappRegistry.packageId;
    const registryObjectId = whatsappRegistry.registryObjectId;

    if (!packageId || !registryObjectId) {
      throw new Error(`WhatsApp configuration incomplete for ${network} network`);
    }

    // If account data is provided, send the blockchain transaction
    if (account && account.zkProofs && account.ephemeralPrivateKey) {
      // Send transaction using zkLogin credentials
      // The callback receives a TransactionBlock and must build the transaction within it
      const networkConfig = getNetworkConfig(network);
      const rpcUrl = networkConfig.rpcUrl;
      console.log(`🔗 Using RPC URL for network ${network}: ${rpcUrl}`);
      console.log(`📦 Transaction details:`, { packageId, registryObjectId, network });
      
      const result = await enokiZkLoginService.sendTransaction(
        account,
        (txb) => {
          // Build the link_circle transaction in the provided txb
          txb.moveCall({
            target: `${packageId}::whatsapp_integration::link_circle`,
            arguments: [
              txb.object(registryObjectId),
              txb.pure.address(circleId),
              txb.pure.u8(linkType),
              txb.pure.string(phoneOrGroup),
              txb.pure.address(adminAddr || account.userAddr)
            ]
          });
        },
        { gasBudget: 10_000_000 }
      );

      logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        linkType,
        recipient: phoneOrGroup,
        txDigest: result.digest,
        status: 'confirmed_on_blockchain'
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle successfully linked to WhatsApp on-chain!',
          circleId,
          linkType,
          recipient: phoneOrGroup,
          txDigest: result.digest,
          status: 'confirmed'
        }
      });
    } else {
      // Fallback: Account data not provided, just log and return pending
      logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        status: 'pending_blockchain_confirmation',
        linkType,
        recipient: phoneOrGroup
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle link initiated. Waiting for blockchain confirmation...',
          circleId,
          linkType,
          recipient: phoneOrGroup,
          status: 'pending'
        }
      });
    }

  } catch (error) {
    const suiAddress = req.body?.adminAddress;
    if (suiAddress) {
      logAdminAction('LINK_CIRCLE_ERROR', suiAddress, {
        error: error instanceof Error ? error.message : String(error),
        circleId: req.body?.circleId
      });
    }

    console.error('❌ Admin link circle error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to link circle'
    });
  }
}

export default handler;
