const asyncHandler = require('express-async-handler');
const stripe = require('../config/stripeconfig');
const Auctions = require('../models/Auction');
const Payout = require('../models/Payout');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// This one is only for auctions
const createPaymentIntent = asyncHandler(async (req, res) => {
    try {
        const { amount, currency = 'usd' } = req.body;

        // Create a PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100, // Stripe expects amount in cents
            currency,
            automatic_payment_methods: {
                enabled: true,
            },
        });

        res.status(200).json({
            clientSecret: paymentIntent.client_secret,
        });
    } catch (error) {
        res.status(400).json({
            message: error.message,
        });
    }
});

// Handle Stripe webhook events
const handleWebhook = asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
  
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
  
        // Find the auction associated with this payment
        const auction = await Auctions.findOne({ paymentIntentId: paymentIntent.id });
        if (auction) {
          auction.status = 'paid'; // Mark auction as paid
          await auction.save();
  
          // Additional business logic here, like notifying the seller
        }
        break;
  
      case 'payment_intent.payment_failed':
        // Handle failed payment
        break;
  
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  
    res.json({ received: true });
});
  

// Retrieve payment details
const getPaymentDetails = asyncHandler(async (req, res) => {
    const { paymentIntentId } = req.params;
    
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        res.json(paymentIntent);
    } catch (error) {
        res.status(404).json({
            message: 'Payment not found',
        });
    }
});

const createConnectedAccount = asyncHandler(async (req, res) => {
  try {
    console.log('Create connected account request received:', {
      body: req.body,
      user: req.user,
      headers: req.headers
    });
    
    const { 
      email, 
      firstName, 
      lastName, 
      phone,
      dob,
      address,
      ssn_last_4,
      business_profile,
      tos_acceptance
    } = req.body;
    
    // Get the authenticated user - handle both id and _id cases
    const userId = req.user.id || req.user._id;
    console.log('Using userId:', userId);
    
    const user = await User.findById(userId);
    console.log('Found user:', user ? 'yes' : 'no');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user already has a connected account
    if (user.stripeAccountId) {
      return res.status(200).json({
        accountId: user.stripeAccountId,
        message: 'Connected account already exists'
      });
    }

    // Create Stripe Connect account with all required fields
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: email || user.email,
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      individual: {
        first_name: firstName || user.firstName,
        last_name: lastName || user.lastName,
        email: email || user.email,
        phone: phone,
        dob: {
          day: dob.day,
          month: dob.month,
          year: dob.year
        },
        address: {
          line1: address.line1,
          city: address.city,
          state: address.state,
          postal_code: address.postal_code,
          country: 'US'
        },
        ssn_last_4: ssn_last_4
      },
      business_profile: {
        url: business_profile.url,
        mcc: business_profile.mcc || '5812', // Default to restaurants/food service if not provided
      },
      tos_acceptance: {
        date: tos_acceptance.date,
        ip: tos_acceptance.ip
      },
      settings: {
        payments: {
          statement_descriptor: `${firstName} ${lastName}`.substring(0, 22) // Max 22 chars
        }
      }
    });

    // Update user with Stripe account ID
    user.stripeAccountId = account.id;
    await user.save();

    // Create an account link for the user to complete verification if needed
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.FRONTEND_URL}/dashboard/payouts`,
      return_url: `${process.env.FRONTEND_URL}/dashboard/payouts`,
      type: 'account_onboarding',
    });

    res.status(200).json({
      accountId: account.id,
      accountLink: accountLink.url,
      message: 'Connected account created successfully'
    });
  } catch (error) {
    console.error('Create connected account error:', error);
    res.status(400).json({ 
      error: error.message || 'Failed to create connected account'
    });
  }
});

const addBankAccount = asyncHandler(async (req, res) => {
    try {
        const { accountId, bankAccountDetails } = req.body;
        console.log('Add bank account request:', {
            receivedAccountId: accountId,
            bankDetails: bankAccountDetails
        });

        // Verify that this connected account belongs to the authenticated user
        const user = await User.findById(req.user._id);
        console.log('User stripe details:', {
            userId: user?._id,
            userStripeAccountId: user?.stripeAccountId,
            matches: user?.stripeAccountId === accountId
        });

        if (!user || user.stripeAccountId !== accountId) {
            return res.status(403).json({
                message: 'Not authorized to add bank account to this Stripe account'
            });
        }

        const bankAccount = await stripe.accounts.createExternalAccount(
            accountId,
            {
                external_account: {
                    object: 'bank_account',
                    country: 'US',
                    currency: 'usd',
                    account_number: bankAccountDetails.accountNumber,
                    routing_number: bankAccountDetails.routingNumber,
                    account_holder_name: bankAccountDetails.holderName,
                    account_holder_type: 'individual' 
                }
            }
        );

        res.status(200).json({
            bankAccountId: bankAccount.id,
            message: 'Bank account added successfully!',
        });
    } catch (error) {
        // Provide more detailed error message
        const message = error.type === 'StripeInvalidRequestError' 
            ? 'Invalid bank account details'
            : error.message;
            
        res.status(400).json({
            message: message,
        });
    }
});

const createPayout = asyncHandler(async (req, res) => {
    try {
        const { amount, currency = 'usd', accountId } = req.body;

        // Create a payout from the connected account to the linked bank account
        const payout = await stripe.payouts.create(
            {
                amount: amount * 100, // Amount in cents
                currency,
            },
            {
                stripeAccount: accountId,
            }
        );

        res.status(200).json({
            payoutId: payout.id,
            message: 'Payout created successfully!',
        });
    } catch (error) {
        res.status(400).json({
            message: error.message,
        });
    }
});

const createPayoutForAuction = asyncHandler(async (req, res) => {
    const { auctionId } = req.body;

    try {
        const auction = await Auctions.findById(auctionId).populate('product');

        if (!auction || auction.status !== 'paid') {
            return res.status(400).json({ message: 'Auction not found or not eligible for payout' });
        }

        const farmer = auction.product.user;

        // Create a payout using Stripe
        const payout = await stripe.payouts.create(
            {
                amount: auction.winningBid.amount * 100, // Amount in cents
                currency: 'usd'
            },
            {
                stripeAccount: farmer.stripeAccountId
            }
        );

        // Record the payout in the Payout model
        const newPayout = new Payout({
            userId: farmer._id,
            amount: auction.winningBid.amount,
            date: new Date(),
            stripePayoutId: payout.id
        });

        await newPayout.save();

        res.status(200).json({ message: 'Payout created successfully!', payout: newPayout });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const getSellerBalance = asyncHandler(async (req, res) => {
  try {
    // Look up the seller using the authenticated user's ID
    const seller = await User.findById(req.user.id);
    
    // If no seller or no Stripe account, return early with redirect
    if (!seller || !seller.stripeAccountId) {
      return res.status(200).json({ 
        redirect: '/create-connected-account',
        message: 'Connected account required'
      });
    }
  
    // Get the balance from Stripe
    const balance = await stripe.balance.retrieve({
      stripeAccount: seller.stripeAccountId,
    });

    // Get external accounts (bank accounts)
    const accounts = await stripe.accounts.retrieve(seller.stripeAccountId);
    
    // Return combined data
    res.status(200).json({
      ...balance,
      external_accounts: accounts.external_accounts,
      stripeAccountId: seller.stripeAccountId
    });
  } catch (error) {
    res.status(400).json({ 
      error: error.message,
      redirect: '/create-connected-account'
    });
  }
});
  
// Retrieve the seller's payout history from Stripe
const getSellerTransfers = asyncHandler(async (req, res) => {
  // Look up the seller using the authenticated user's ID
  const seller = await User.findById(req.user.id);
  if (!seller || !seller.stripeAccountId) {
    return res.status(200).json({ redirect: '/create-connected-account', message: 'Seller transfers message ' });
  }

  // List payouts (transfers) for the connected account
  const payouts = await stripe.payouts.list(
    { limit: 100 },
    { stripeAccount: seller.stripeAccountId }
  );

  res.status(200).json(payouts.data);
});

const requestPayout = asyncHandler(async (req, res) => {
    try {
        const { transactionId } = req.body;

        // Get the authenticated user
        const user = await User.findById(req.user._id);
        if (!user || !user.stripeAccountId) {
            return res.status(400).json({
                message: 'No connected account found for this user'
            });
        }

        // Find the transaction and verify ownership
        const transaction = await Transaction.findById(transactionId)
            .populate('buyer')
            .populate('seller');

        if (!transaction) {
            return res.status(404).json({
                message: 'Transaction not found'
            });
        }

        if (transaction.seller.toString() !== user._id.toString()) {
            return res.status(403).json({
                message: 'Not authorized to request payout for this transaction'
            });
        }

        if (transaction.payoutStatus === 'completed') {
            return res.status(400).json({
                message: 'Payout has already been processed for this transaction'
            });
        }

        // Calculate payout amount (considering platform fees)
        const platformFee = transaction.amount * 0.05; // 5% platform fee
        const payoutAmount = transaction.amount - platformFee;

        // Create an instant payout to the default bank account
        const payout = await stripe.payouts.create({
            amount: Math.round(payoutAmount * 100), // Convert to cents
            currency: 'usd',
            method: 'instant', // Use instant payout if available
            metadata: {
                transactionId: transaction._id.toString()
            }
        }, {
            stripeAccount: user.stripeAccountId,
        });

        // Record the payout in our database
        const newPayout = new Payout({
            userId: user._id,
            transaction: transaction._id,
            amount: payoutAmount,
            stripePayoutId: payout.id,
            status: payout.status,
            metadata: {
                platformFee: platformFee.toString(),
                originalAmount: transaction.amount.toString()
            }
        });
        await newPayout.save();

        // Update transaction status
        transaction.payoutStatus = 'completed';
        transaction.payout = newPayout._id;
        await transaction.save();

        res.status(200).json({
            success: true,
            payout: {
                id: payout.id,
                amount: payoutAmount,
                status: payout.status,
                expectedArrival: payout.arrival_date,
                transaction: transaction._id
            }
        });

    } catch (error) {
        console.error('Payout error:', error);
        res.status(400).json({
            message: error.type === 'StripeInvalidRequestError' 
                ? 'Unable to process payout. Please verify bank account details.'
                : error.message
        });
    }
});

module.exports = {
    addBankAccount,
    createPayout,
    createConnectedAccount,
    createPaymentIntent,
    handleWebhook,
    getPaymentDetails,
    createPayoutForAuction,
    getSellerBalance,
    getSellerTransfers,
    requestPayout
};
