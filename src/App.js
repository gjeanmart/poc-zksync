import React, { useState, useEffect } from 'react'
import './App.css';
import { Magic } from 'magic-sdk'
import { ethers } from "ethers"


const MAGIC_API_KEY = "pk_test_0528D66ABD57E169"
const CONNECTION_MNEMONIC = "mnemonic"
const CONNECTION_METAMASK = "metamask"
const CONNECTION_MAGIC = "magic.link"
const NETWORK = 'mainnet'
const USE_WEBSOCKET = false;

function App() {

  const [zksync, setZksync] = useState()
  const [magic, setMagic] = useState()
  const [tokens, setTokens] = useState()
  const [transferData, setTransferData] = useState({amount: 0, to: "0x"})
  const [selectedToken, setSelectedToken] = useState("ETH")
  const [balances, setBalances] = useState({eth: null, sync: null, fee: null})
  const [connection, setConnection] = useState({
    status: 'disconnected',
    type: CONNECTION_METAMASK,
    data: "",
    address: null,
    syncWallet: null
  })

  useEffect(() => {
    async function init() {
      const zksync = await import('zksync')
      setZksync(zksync)
    }
    init();    
  }, []);

  const onTypeChange = event => {
    setConnection({...connection, type: event.target.value})
  }

  const onSelectedTokenChange = event => {
    setSelectedToken(event.target.value)
  }

  const onConnectionDataChange = event => {
    setConnection({...connection, data: event.target.value})
  }

  const onTransferAmountChange = event => {
    setTransferData({...transferData, amount: event.target.value})
  }

  const onTransferToChange = event => {
    setTransferData({...transferData, to: event.target.value})
  }

  const login = async () => {
    setConnection({...connection, status: 'connecting'})

    // LOGIN ETHEREUM
    let ethWallet;
    if(connection.type === CONNECTION_MNEMONIC) {
      const provider = new ethers.getDefaultProvider(NETWORK)
      ethWallet = ethers.Wallet.fromMnemonic(connection.data).connect(provider);

    } else if (connection.type === CONNECTION_METAMASK) {
      await window.ethereum.request({ method: 'eth_requestAccounts' })
      const provider = new ethers.providers.Web3Provider(window.web3.currentProvider);
      ethWallet = provider.getSigner()

    } else if (connection.type === CONNECTION_MAGIC) {
      const magic = new Magic(MAGIC_API_KEY);
      setMagic(magic)
      if(! await magic.user.isLoggedIn()) {
        await magic.auth.loginWithMagicLink({email: connection.data});
      } 
      const provider = new ethers.providers.Web3Provider(magic.rpcProvider);
      ethWallet = provider.getSigner()

    } else {
      throw new Error("Unknown type")
    }
    
    // LOGIN ZKSYNC
    let syncProvider
    if(USE_WEBSOCKET) {
      syncProvider = await zksync.getDefaultProvider("mainnet")
    } else {
      syncProvider = await zksync.Provider.newHttpProvider("https://api.zksync.io/jsrpc")
    }

    const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider, null, null, "EIP1271Signature");
    console.log(syncWallet)
    const accountId = await syncWallet.getAccountId()
    console.log("Account ID = " + accountId)
    const accountState = await syncWallet.getAccountState()
    console.log(accountState)
    const tokens = await syncProvider.getTokens()
    setTokens(tokens)

    // BALANCE
    await getBalances(syncWallet, syncProvider, tokens)

    // ATTEMPT TO CREATE THE SIGNING KEY
    await createSigningKey(syncWallet)

    // STATE
    setConnection({...connection, status: 'connected', syncWallet, syncProvider, address: syncWallet.address()})

    // POST-LOGIN
    setInterval(async () => await getBalances(syncWallet, syncProvider, tokens), 30000)
  }

  const createSigningKey = async syncWallet => {
    const accountState = await syncWallet.getAccountState()
    
    if (Object.keys(accountState.committed.balances).length !== 0 
        && !await syncWallet.isSigningKeySet()) {
      const txn = await syncWallet.setSigningKey();
      const receipt = await txn.awaitReceipt();
      console.log(receipt)
    }  
  }

  const logout = async () => {
    if (connection.type === CONNECTION_MAGIC) {
      await magic.user.logout()
    }
    setConnection({
      status: 'disconnected',
      type: CONNECTION_METAMASK,
      data: "",
      address: null,
      syncWallet: null
    })
  }

  const getBalances = async (syncWallet, syncProvider, tokens) => {
    let balances = {eth: {}, sync: {}, fee: {}}
    for(const token in tokens) {
      const balanceEth = await getBalance(syncWallet, "eth", tokens[token])
      balances["eth"][token] = balanceEth
      const balanceSync = await getBalance(syncWallet, "sync", tokens[token])
      balances["sync"][token] = balanceSync
      const fee = await getFee(syncProvider, tokens[token])
      balances["fee"][token] = fee
    }
    setBalances(balances)
  } 

  const getFee = async (provider, token) => {
    const fee = await provider.getTransactionFee({ ChangePubKey: { onchainPubkeyAuth: false} }, "0x4fb90cE4D11d42F9A7967Dd4D1D2d5F3908Cb6b9", token.symbol);
    console.log("fee="+ethers.utils.formatUnits(fee.totalFee, token.decimals) + " " + token.symbol)
    return ethers.utils.formatUnits(fee.totalFee, token.decimals)
  }

  const getBalance = async (wallet, chain, token) => {
    if(chain === "eth") {
      const bal = await wallet.getEthereumBalance(token.symbol)
      return ethers.utils.formatEther(bal)

    } else if (chain === "sync") {
      const bal = await wallet.getBalance(token.symbol);
      return ethers.utils.formatEther(bal)
    }
  }

  const refreshBalance = async (wallet, chain, token) => {
    const bal = await getBalance(wallet, chain, token)
    let b = Object.assign({}, balances);
    b[chain][token.symbol] = bal
    setBalances(b)
  }

  const deposit = async () => {
    const txn = await connection.syncWallet.depositToSyncFromEthereum({
      depositTo: transferData.to,
      token: selectedToken,
      amount: ethers.utils.parseEther(transferData.amount),
      approveDepositAmountForERC20: true
    });
    console.log(txn)
    setTransferData({amount: 0, to: "0x"})

    const receipt = await txn.awaitReceipt();
    console.log(receipt)

    await createSigningKey(connection.syncWallet)
  }

  const withdraw = async () => { 
    const fee = await connection.syncProvider.getTransactionFee("Withdraw", connection.address, selectedToken)
  
    const txn = await connection.syncWallet.withdrawFromSyncToEthereum({
        ethAddress: transferData.to,
        token: selectedToken,
        amount: ethers.utils.parseEther(transferData.amount),
        fee: fee.totalFee,
    });
    console.log(txn)

    setTransferData({amount: 0, to: "0x"})

    const verifyreceipt = await txn.awaitVerifyReceipt();
    console.log(verifyreceipt)
  }

  const transfer = async () => {
    const amount = zksync.utils.closestPackableTransactionAmount(
        ethers.utils.parseEther(transferData.amount)); 

    const fee = await connection.syncProvider.getTransactionFee("Transfer", transferData.to, selectedToken)

    const txn = await connection.syncWallet.syncTransfer({
        to: transferData.to,
        token: selectedToken,
        amount,
        fee: fee.totalFee
    });
    console.log(txn)

    setTransferData({amount: 0, to: "0x"})

    const receipt = await txn.awaitReceipt();
    console.log(receipt)
  }

  return (
    <div className="App">
      <h1> ZkSync PoC</h1>

      <hr></hr>

      <h3>Connection</h3>
      <div>Status: {connection.status} {connection.status === 'connected' && (<button onClick={() => logout()} size="small">logout</button>)}</div>
      {connection.status === 'disconnected' && (
        <div>
          <div>
            Types: 
            <select value={connection.type} onChange={onTypeChange}>
              <option value={CONNECTION_MNEMONIC}>{CONNECTION_MNEMONIC}</option>
              <option value={CONNECTION_METAMASK}>{CONNECTION_METAMASK}</option>
              <option value={CONNECTION_MAGIC}>{CONNECTION_MAGIC}</option>
            </select>
          </div>
          {connection.type === CONNECTION_MNEMONIC && (
            <div>
              Mnemonic: <input type="text" value={connection.data} onChange={onConnectionDataChange} />
            </div>
          )}
          {connection.type === CONNECTION_MAGIC && (
            <div>
              Email: <input type="email" value={connection.data} onChange={onConnectionDataChange} />
            </div>
          )}     
          <div>
              <button onClick={() => login()} size="small">login</button>
          </div>
        </div>   
      )}
      {connection.status === 'connected' && (
        <>
          <div>Address: {connection.address}</div>
        </>
      )}

      <hr></hr>
      {connection.status === 'connected' && (
        <>
          <h3>Balances</h3>
          <div className={`split left`}>
            <h5>ETH1.x</h5>
            {Object.keys(tokens).map((token, index) => {
              return <div key={"eth"+token}>Balance: {balances.eth[token]} {token} <a onClick={() => refreshBalance(connection.syncWallet, "eth", tokens[token])}><span role="img">🔄</span></a></div>  
            })}
            
          </div>
          <div className={`split right`}>
            <h5>ZkSync</h5>
            {Object.keys(tokens).map((token, index) => {
              return <div key={"sync"+token}>Balance: {balances.sync[token]} {token} (fee: {balances.fee[token]} {token}) <a onClick={() => refreshBalance(connection.syncWallet, "sync", tokens[token])}><span role="img">🔄</span></a></div>  
            })}           
          </div>

          <hr></hr>
          <h3>Deposit</h3>
          To: <input type="text" value={transferData.to} onChange={onTransferToChange} />&nbsp;
          Amount: <input type="text" value={transferData.amount} onChange={onTransferAmountChange} /> &nbsp;
          <select value={selectedToken} onChange={onSelectedTokenChange}>
            {Object.keys(tokens).map((token, index) => {
              return <option value={token}>{token}</option> 
            })}  
          </select> &nbsp;
          <button onClick={() => deposit()} size="small">deposit</button>

          <hr></hr>
          <h3>Withdrawal</h3>
          To: <input type="text" value={transferData.to} onChange={onTransferToChange} />&nbsp;
          Amount: <input type="text" value={transferData.amount} onChange={onTransferAmountChange} /> &nbsp;
          <select value={selectedToken} onChange={onSelectedTokenChange}>
            {Object.keys(tokens).map((token, index) => {
              return <option value={token}>{token}</option> 
            })}  
          </select>&nbsp;
          <button onClick={() => withdraw()} size="small">withdraw</button>
          
          <hr></hr>
          <h3>Transfer</h3>
          To: <input type="text" value={transferData.to} onChange={onTransferToChange} />&nbsp;
          Amount: <input type="text" value={transferData.amount} onChange={onTransferAmountChange} /> &nbsp;
          <select value={selectedToken} onChange={onSelectedTokenChange}>
            {Object.keys(tokens).map((token, index) => {
              return <option value={token}>{token}</option> 
            })}  
          </select>&nbsp;
          <button onClick={() => transfer()} size="small">transfer</button>
        </>
      )}
    </div>
  );
}

export default App;
