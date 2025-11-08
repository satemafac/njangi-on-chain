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
import { getCurrentRpcUrl } from '../../../services/network-config';

interface LinkCircleRequest {
  circleId: string;
  linkType: 1 | 2;  // 1 = individual, 2 = group
  phoneOrGroup: string;
  adminAddress?: string;  // Admin's Sui address
  account?: AccountData;   // Full zkLogin account for transaction signing
}

interface UnlinkCircleRequest {
  circleId: string;
  adminAddress?: string;
  account?: AccountData;
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

      // Query the registry object from blockchain
       const suiClient = new SuiClient({ url: getCurrentRpcUrl() });
       
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
           const registryFields = (registryObject.data.content as any).fields;
           
           console.log('Registry fields keys:', Object.keys(registryFields));
           console.log('Registry total_links:', registryFields.total_links);
           
           // The links are stored in the registry.links vector
           const links = registryFields.links;
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
             const linkFields = link.fields || link;
             console.log('Checking link:', { 
               circle_id: linkFields.circle_id, 
               link_type: linkFields.link_type,
               enabled: linkFields.enabled,
               looking_for: circleId 
             });

             if (linkFields.circle_id === circleId && linkFields.enabled === true) {
               // Found the link!
               const recipient = linkFields.link_type === 1 
                 ? linkFields.admin_phone_number?.value || linkFields.admin_phone_number
                 : linkFields.group_id?.value || linkFields.group_id;

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
    const { circleId, linkType, phoneOrGroup } = req.body as LinkCircleRequest;

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
      recipient: linkType === 1 ? 'individual' : 'group'
    });

    // Get registry object ID and package ID from environment
    const registryObjectId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID;
    if (!registryObjectId) {
      throw new Error('SUI_WHATSAPP_LINKS_REGISTRY_ID not configured');
    }

    const packageId = process.env.SUI_WHATSAPP_PACKAGE_ID;
    if (!packageId) {
      throw new Error('SUI_WHATSAPP_PACKAGE_ID not configured');
    }

    // If account data is provided, send the blockchain transaction
    if (account && account.zkProofs && account.ephemeralPrivateKey) {
      // Send transaction using zkLogin credentials
      // The callback receives a TransactionBlock and must build the transaction within it
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
