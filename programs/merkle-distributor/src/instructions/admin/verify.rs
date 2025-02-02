use anchor_lang::{prelude::*, system_program::System};
use spl_account_compression::{
    canopy::fill_in_proof_from_canopy,
    concurrent_tree_wrapper::{merkle_tree_prove_leaf, ProveLeafArgs},
    program::SplAccountCompression,
    state::{
        merkle_tree_get_size, ConcurrentMerkleTreeHeader, CONCURRENT_MERKLE_TREE_HEADER_SIZE_V1,
    },
    AccountCompressionError, Noop,
};

use crate::state::merkle_distributor::MerkleDistributor;

#[derive(Accounts)]
pub struct VerifyLeaf<'info> {
    pub distributor: AccountLoader<'info, MerkleDistributor>,

    #[account(zero)]
    /// CHECK: This account must be all zeros
    pub merkle_tree: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub tree_creator: Signer<'info>,
    pub log_wrapper: Program<'info, Noop>,

    pub compression_program: Program<'info, SplAccountCompression>,
    pub system_program: Program<'info, System>,
}

pub fn verify_leaf(
    ctx: Context<VerifyLeaf>,
    root: [u8; 32],
    leaf: [u8; 32],
    index: u32,
    mut proof: Vec<[u8; 32]>,
) -> Result<()> {
    require_eq!(
        *ctx.accounts.merkle_tree.owner,
        crate::id(),
        AccountCompressionError::IncorrectAccountOwner
    );
    let merkle_tree_bytes = ctx.accounts.merkle_tree.try_borrow_data()?;
    let (header_bytes, rest) = merkle_tree_bytes.split_at(CONCURRENT_MERKLE_TREE_HEADER_SIZE_V1);

    let header = ConcurrentMerkleTreeHeader::try_from_slice(header_bytes)?;
    header.assert_valid()?;
    header.assert_valid_leaf_index(index)?;

    let merkle_tree_size = merkle_tree_get_size(&header)?;
    let (tree_bytes, canopy_bytes) = rest.split_at(merkle_tree_size);

    fill_in_proof_from_canopy(canopy_bytes, header.get_max_depth(), index, &mut proof)?;
    let id = ctx.accounts.merkle_tree.key();

    let args = &ProveLeafArgs {
        current_root: root,
        leaf,
        proof_vec: proof,
        index,
    };
    merkle_tree_prove_leaf(&header, id, tree_bytes, args)?;

    Ok(())
}
