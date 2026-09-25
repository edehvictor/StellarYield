import { useState } from 'react';

export default function Emergency() {
	const [contractId, setContractId] = useState('');
	const [userAddress, setUserAddress] = useState('');
	const [shares, setShares] = useState<string>('0');
	const [status, setStatus] = useState<string>('');

	async function callEmergencyWithdraw() {
		try {
			setStatus('Connecting...');
			// NOTE: In a real deployment, wire Soroban connection, network RPC,
			// and wallet auth here. This minimalist page purposely avoids app
			// dependencies. Replace the following with your wallet integration.
			// Example placeholder:
			// const server = new SorobanClient.Server(RPC_URL, { allowHttp: true });
			// const result = await invokeEmergencyWithdraw(server, contractId, userAddress, BigInt(shares));
			// setStatus(`Success: withdrew ${result} units`);
			setStatus('Please integrate wallet + Soroban RPC to execute emergency_withdraw.');
		} catch (e: any) {
			setStatus(`Error: ${e?.message ?? String(e)}`);
		}
	}

	return (
		<div style={{ maxWidth: 560, margin: '40px auto', fontFamily: 'Inter, system-ui, Arial' }}>
			<h1>Emergency Withdraw</h1>
			<p style={{ color: '#c00', fontWeight: 600 }}>
				Warning: Emergency withdrawals may incur penalties or slippage and only use idle reserves.
			</p>
			<label style={{ display: 'block', marginTop: 16 }}>
				Vault Contract ID
				<input
					value={contractId}
					onChange={e => setContractId(e.target.value)}
					placeholder="e.g., CABC...XYZ"
					style={{ width: '100%', padding: 8, marginTop: 6 }}
				/>
			</label>
			<label style={{ display: 'block', marginTop: 16 }}>
				Your Address
				<input
					value={userAddress}
					onChange={e => setUserAddress(e.target.value)}
					placeholder="e.g., GABC...XYZ"
					style={{ width: '100%', padding: 8, marginTop: 6 }}
				/>
			</label>
			<label style={{ display: 'block', marginTop: 16 }}>
				Shares to Burn
				<input
					type="number"
					value={shares}
					onChange={e => setShares(e.target.value)}
					style={{ width: '100%', padding: 8, marginTop: 6 }}
				/>
			</label>
			<button onClick={callEmergencyWithdraw} style={{ marginTop: 20, padding: '10px 16px' }}>
				Call emergency_withdraw
			</button>
			<div style={{ marginTop: 16, minHeight: 24 }}>{status}</div>
			<hr style={{ margin: '24px 0' }} />
			<p style={{ fontSize: 12, color: '#555' }}>
				This page is designed for independent hosting (e.g., Vercel/IPFS) to operate even if the main frontend is down.
			</p>
		</div>
	);
}
