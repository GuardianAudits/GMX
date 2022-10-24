async function deployContract(name, args, contractOptions) {
  const contractFactory = await ethers.getContractFactory(name, contractOptions);
  return await contractFactory.deploy(...args);
}

async function contractAt(name, address) {
  const contractFactory = await ethers.getContractFactory(name);
  return await contractFactory.attach(address);
}

module.exports = {
  deployContract,
  contractAt,
};
