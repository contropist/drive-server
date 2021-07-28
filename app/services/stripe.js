const StripeTest = require('stripe')(process.env.STRIPE_SK_TEST, { apiVersion: '2020-08-27' });
const StripeProduction = require('stripe')(process.env.STRIPE_SK, { apiVersion: '2020-08-27' });

module.exports = () => {
  const getStripe = (isTest = false) => {
    return isTest ? StripeTest : StripeProduction;
  };

  const getStorageProducts = (test = false) => new Promise((resolve, reject) => {
    const stripe = getStripe(test);

    stripe.products.list({
      limit: 100
    }, (err, products) => {
      if (err) {
        reject(err);
      } else {
        const productsMin = products.data
          .filter((p) => p.metadata.is_drive === '1')
          .map((p) => ({ id: p.id, name: p.name, metadata: p.metadata }))
          .sort((a, b) => a.metadata.size_bytes * 1 - b.metadata.size_bytes * 1);
        resolve(productsMin);
      }
    });
  });

  const getTeamProducts = (test = false) => new Promise((resolve, reject) => {
    const stripe = getStripe(test);

    stripe.products.list({
      limit: 100
    }, (err, products) => {
      if (err) {
        reject(err);
      } else {
        const productsMin = products.data
          .filter((p) => p.metadata.is_teams === '1')
          .map((p) => ({ id: p.id, name: p.name, metadata: p.metadata }))
          .sort((a, b) => a.metadata.size_bytes * 1 - b.metadata.size_bytes * 1);
        resolve(productsMin);
      }
    });
  });

  const getStoragePlans = (stripeProduct, test = false) => new Promise((resolve, reject) => {
    const stripe = getStripe(test);

    stripe.plans.list({ product: stripeProduct, active: true },
      (err, plans) => {
        if (err) {
          reject(err.message);
        } else {
          const plansMin = plans.data.map((p) => ({
            id: p.id,
            price: p.amount,
            name: p.nickname,
            interval: p.interval,
            interval_count: p.interval_count
          })).sort((a, b) => a.price * 1 - b.price * 1);
          resolve(plansMin);
        }
      });
  });

  const getTeamPlans = (stripeProduct, test = false) => new Promise((resolve, reject) => {
    const stripe = getStripe(test);

    stripe.plans.list({ product: stripeProduct, active: true }, (err, plans) => {
      if (err) {
        reject(err.message);
      } else {
        const plansMin = plans.data
          .map((p) => ({
            id: p.id,
            price: p.amount,
            name: p.nickname,
            interval: p.interval,
            interval_count: p.interval_count
          })).sort((a, b) => a.price * 1 - b.price * 1);
        resolve(plansMin);
      }
    });
  });

  const findCustomerByEmail = async (email, isTest = false) => {
    const stripe = getStripe(isTest);
    const result = await stripe.customers.list({ email, limit: 1 });
    return result.data && result.data[0];
  };

  const getBilling = async (customerID, url, isTest = false) => {
    const stripe = getStripe(isTest);
    const result = await stripe.billingPortal.sessions.create({
      customer: customerID,
      return_url: url
    });
    return result.url;
  };

  const getStripeProductInfoUser = async (email, isTest) => {
    const stripe = await getStripe(isTest);

    const customer = await findCustomerByEmail(email, isTest);
    const expandedCostumer = await stripe.customers.retrieve(customer.id, {
      expand: ['subscriptions']
    });
    const { plan } = expandedCostumer.subscriptions.data[expandedCostumer.subscriptions.data.length - 1];

    const retrieveProduct = await stripe.products.retrieve(plan.product);

    const stripeProductInfoUser = {
      productId: retrieveProduct.id,
      name: retrieveProduct.name,
      price: retrieveProduct.metadata.price_eur,
      paymentInterval: plan.nickname,
      planId: plan.id
    };
    return stripeProductInfoUser;
  };

  return {
    Name: 'Stripe',
    getStorageProducts,
    getStoragePlans,
    getTeamProducts,
    getTeamPlans,
    findCustomerByEmail,
    getBilling,
    getStripeProductInfoUser
  };
};
