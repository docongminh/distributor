use crate::error::ErrorCode::ArithmeticError;
use crate::state::merkle_distributor::{ActivationType, ClaimType};
use crate::{
    error::ErrorCode,
    state::merkle_distributor::{AirdropBonus, MerkleDistributor},
};
use anchor_lang::{account, context::Context, prelude::*, Accounts, Key, ToAccountInfo};
use anchor_spl::token::{Mint, Token, TokenAccount};
use bytemuck::cast_slice;
use spl_account_compression::{
    program::SplAccountCompression,
    state::{
        merkle_tree_get_size, ConcurrentMerkleTreeHeader, CONCURRENT_MERKLE_TREE_HEADER_SIZE_V1,
    },
    Node, Noop,
};

#[cfg(feature = "localnet")]
const SECONDS_PER_DAY: i64 = 0;

const MAX_ACC_PROOFS_SIZE: u32 = 17;

#[cfg(not(feature = "localnet"))]
const SECONDS_PER_DAY: i64 = 24 * 3600; // 24 hours * 3600 seconds

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct NewDistributorParams {
    pub version: u64,
    pub root: [u8; 32],
    pub max_depth: u32,
    pub max_buffer_size: u32,
    pub start_index: u32,
    pub canopy_nodes: Vec<[u8; 32]>,
    pub rightmost_leaf: [u8; 32],
    pub rightmost_index: u32,
    pub total_claim: u64,
    pub max_num_nodes: u64,
    pub start_vesting_ts: i64,
    pub end_vesting_ts: i64,
    pub clawback_start_ts: i64,
    pub activation_point: u64, // can be slot or timestamp
    pub activation_type: u8,
    pub closable: bool,
    pub total_bonus: u64,
    pub bonus_vesting_duration: u64,
    pub claim_type: u8,
    pub operator: Pubkey,
    pub locker: Pubkey,
    pub parent_account: Pubkey,
}

impl NewDistributorParams {
    pub fn get_max_total_claim(&self) -> Result<u64> {
        let max_total_claim = self
            .total_claim
            .checked_add(self.total_bonus)
            .ok_or(ArithmeticError)?;
        Ok(max_total_claim)
    }
    fn get_airdrop_bonus(&self) -> AirdropBonus {
        AirdropBonus {
            total_bonus: self.total_bonus,
            vesting_duration: self.bonus_vesting_duration,
            total_claimed_bonus: 0,
        }
    }

    pub fn validate(&self) -> Result<()> {
        ActivationType::try_from(self.activation_type)
            .map_err(|_| ErrorCode::InvalidActivationType)?;

        let curr_ts = Clock::get()?.unix_timestamp;

        require!(
            self.start_vesting_ts < self.end_vesting_ts,
            ErrorCode::StartTimestampAfterEnd
        );

        require!(
            self.clawback_start_ts > self.end_vesting_ts,
            ErrorCode::ClawbackDuringVesting
        );

        // New distributor parameters must all be set in the future
        require!(
            self.start_vesting_ts > curr_ts,
            ErrorCode::TimestampsNotInFuture
        );

        // Ensure clawback_start_ts is at least one day after end_vesting_ts
        require!(
            self.clawback_start_ts
                >= self
                    .end_vesting_ts
                    .checked_add(SECONDS_PER_DAY)
                    .ok_or(ErrorCode::ArithmeticError)?,
            ErrorCode::InsufficientClawbackDelay
        );

        // validate claim type
        let claim_type_enum =
            ClaimType::try_from(self.claim_type).map_err(|_| ErrorCode::TypeCastedError)?;
        match claim_type_enum {
            ClaimType::Permissionless => {
                require!(self.locker == Pubkey::default(), ErrorCode::InvalidLocker);
                require!(
                    self.operator == Pubkey::default(),
                    ErrorCode::InvalidOperator
                );
            }
            ClaimType::Permissioned => {
                require!(self.locker == Pubkey::default(), ErrorCode::InvalidLocker);
            }
            ClaimType::PermissionlessWithStaking => {
                require!(self.locker != Pubkey::default(), ErrorCode::InvalidLocker);
                require!(
                    self.operator == Pubkey::default(),
                    ErrorCode::InvalidOperator
                );
            }
            ClaimType::PermissionedWithStaking => {
                require!(self.locker != Pubkey::default(), ErrorCode::InvalidLocker);
            }
        }
        Ok(())
    }
}
/// Accounts for [merkle_distributor::handle_new_distributor].
#[derive(Accounts)]
#[instruction(version: u64)]
pub struct NewDistributor<'info> {
    /// [MerkleDistributor].
    #[account(
        init,
        seeds = [
            b"MerkleDistributor".as_ref(),
            base.key().to_bytes().as_ref(),
            mint.key().to_bytes().as_ref(),
            version.to_le_bytes().as_ref()
        ],
        bump,
        space = 8 + MerkleDistributor::INIT_SPACE,
        payer = admin
    )]
    pub distributor: AccountLoader<'info, MerkleDistributor>,

    #[account(zero)]
    /// CHECK: This account must be all zeros
    pub merkle_tree: UncheckedAccount<'info>,

    /// Base key of the distributor.
    pub base: Signer<'info>,

    /// Clawback receiver token account
    #[account(mut, token::mint = mint)]
    pub clawback_receiver: Account<'info, TokenAccount>,

    /// The mint to distribute.
    pub mint: Account<'info, Mint>,

    /// Token vault
    /// Should create previously
    #[account(
        associated_token::mint = mint,
        associated_token::authority=distributor,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    /// Admin wallet, responsible for creating the distributor and paying for the transaction.
    /// Also has the authority to set the clawback receiver and change itself.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The [Noop] program.
    pub log_wrapper: Program<'info, Noop>,

    /// The [SplAccountCompression] program.
    pub compression_program: Program<'info, SplAccountCompression>,

    /// The [System] program.
    pub system_program: Program<'info, System>,

    /// The [Token] program.
    pub token_program: Program<'info, Token>,
}

/// Creates a new [MerkleDistributor].
/// After creating this [MerkleDistributor],
/// the token_vault should be seeded with max_total_claim tokens.
/// CHECK:
///     1. The start timestamp is before the end timestamp
///     2. The clawback timestamp is after the end timestamp
///     3. The start, end, and clawback_start timestamps are all in the future
///     4. The clawback start is at least one day after end timestamp
#[allow(clippy::too_many_arguments)]
#[allow(clippy::result_large_err)]
pub fn handle_new_distributor<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, NewDistributor<'info>>,
    params: &NewDistributorParams,
) -> Result<()> {
    params.validate()?;

    let mut distributor = ctx.accounts.distributor.load_init()?;

    distributor.bump = ctx.bumps.distributor;
    distributor.version = params.version;
    distributor.root = params.root;
    distributor.mint = ctx.accounts.mint.key();
    distributor.token_vault = ctx.accounts.token_vault.key();
    distributor.max_total_claim = params.get_max_total_claim()?;
    distributor.max_num_nodes = params.max_num_nodes;
    distributor.total_amount_claimed = 0;
    distributor.num_nodes_claimed = 0;
    distributor.start_ts = params.start_vesting_ts;
    distributor.end_ts = params.end_vesting_ts;
    distributor.clawback_start_ts = params.clawback_start_ts;
    distributor.clawback_receiver = ctx.accounts.clawback_receiver.key();
    distributor.admin = ctx.accounts.admin.key();
    distributor.clawed_back = 0;
    if params.closable {
        distributor.closable = 1;
    }
    distributor.base = ctx.accounts.base.key();
    distributor.airdrop_bonus = params.get_airdrop_bonus();
    distributor.claim_type = params.claim_type;
    distributor.activation_point = params.activation_point;
    distributor.activation_type = params.activation_type;
    distributor.operator = params.operator;
    distributor.locker = params.locker;
    distributor.parent_account = params.parent_account;

    // Note: might get truncated, do not rely on
    msg! {
        "New distributor created with version = {}, mint={}, vault={} max_total_claim={}, max_nodes: {}, start_ts: {}, end_ts: {}, clawback_start: {}, clawback_receiver: {} activation_point {} activation_type {} total_bonus {}, bonus_vesting_duration {}, claim_type {}",
            distributor.version,
            distributor.mint,
            ctx.accounts.token_vault.key(),
            distributor.max_total_claim,
            distributor.max_num_nodes,
            distributor.start_ts,
            distributor.end_ts,
            distributor.clawback_start_ts,
            distributor.clawback_receiver,
            distributor.activation_point,
            distributor.activation_type,
            distributor.airdrop_bonus.total_bonus,
            distributor.airdrop_bonus.vesting_duration,
            distributor.claim_type,
    };
    let signer = distributor.signer();
    let seeds = signer.seeds();
    let authority = &[&seeds[..]];

    drop(distributor);

    // init merkle tree & append canopy nodes
    check_canopy_size(&ctx, params.max_depth, params.max_buffer_size)?;

    //
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.compression_program.to_account_info(),
        spl_account_compression::cpi::accounts::Initialize {
            authority: ctx.accounts.distributor.to_account_info(),
            merkle_tree: ctx.accounts.merkle_tree.to_account_info(),
            noop: ctx.accounts.log_wrapper.to_account_info(),
        },
        authority,
    );
    spl_account_compression::cpi::prepare_batch_merkle_tree(
        cpi_ctx,
        params.max_depth,
        params.max_buffer_size,
    )?;

    // Append canopy nodes into merkle tree
    let append_cpi = CpiContext::new_with_signer(
        ctx.accounts.compression_program.to_account_info(),
        spl_account_compression::cpi::accounts::Modify {
            authority: ctx.accounts.distributor.to_account_info(),
            merkle_tree: ctx.accounts.merkle_tree.to_account_info(),
            noop: ctx.accounts.log_wrapper.to_account_info(),
        },
        authority,
    );
    spl_account_compression::cpi::append_canopy_nodes(
        append_cpi,
        params.start_index,
        params.canopy_nodes.clone(),
    )?;

    //
    let init_with_root_cpi = CpiContext::new_with_signer(
        ctx.accounts.compression_program.to_account_info(),
        spl_account_compression::cpi::accounts::Modify {
            authority: ctx.accounts.distributor.to_account_info(),
            merkle_tree: ctx.accounts.merkle_tree.to_account_info(),
            noop: ctx.accounts.log_wrapper.to_account_info(),
        },
        authority,
    )
    .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    spl_account_compression::cpi::init_prepared_tree_with_root(
        init_with_root_cpi,
        params.root,
        params.rightmost_leaf,
        params.rightmost_index,
    )?;

    Ok(())
}

fn check_canopy_size(
    ctx: &Context<NewDistributor>,
    max_depth: u32,
    max_buffer_size: u32,
) -> Result<()> {
    let merkle_tree_bytes = ctx.accounts.merkle_tree.data.borrow();

    let (header_bytes, rest) = merkle_tree_bytes.split_at(CONCURRENT_MERKLE_TREE_HEADER_SIZE_V1);

    let mut header = ConcurrentMerkleTreeHeader::try_from_slice(header_bytes)?;
    header.initialize(
        max_depth,
        max_buffer_size,
        &ctx.accounts.distributor.key(),
        Clock::get()?.slot,
    );

    let merkle_tree_size = merkle_tree_get_size(&header)?;

    let (_tree_bytes, canopy_bytes) = rest.split_at(merkle_tree_size);

    let canopy = cast_slice::<u8, Node>(canopy_bytes);

    let cached_path_len = get_cached_path_length(canopy, max_depth)?;

    let required_canopy = max_depth.saturating_sub(MAX_ACC_PROOFS_SIZE);

    require!(
        (cached_path_len as u32) >= required_canopy,
        ErrorCode::InvalidCanopySize
    );

    Ok(())
}

// Method is taken from account-compression Solana program
#[inline(always)]
fn get_cached_path_length(canopy: &[Node], max_depth: u32) -> Result<u32> {
    // The offset of 2 is applied because the canopy is a full binary tree without the root node
    // Size: (2^n - 2) -> Size + 2 must be a power of 2
    let closest_power_of_2 = (canopy.len() + 2) as u32;
    // This expression will return true if `closest_power_of_2` is actually a power of 2
    if closest_power_of_2 & (closest_power_of_2 - 1) == 0 {
        // (1 << max_depth) returns the number of leaves in the full merkle tree
        // (1 << (max_depth + 1)) - 1 returns the number of nodes in the full tree
        // The canopy size cannot exceed the size of the tree
        if closest_power_of_2 > (1 << (max_depth + 1)) {
            msg!(
                "Canopy size is too large. Size: {}. Max size: {}",
                closest_power_of_2 - 2,
                (1 << (max_depth + 1)) - 2
            );
            return err!(ErrorCode::InvalidCanopySize);
        }
    } else {
        msg!(
            "Canopy length {} is not 2 less than a power of 2",
            canopy.len()
        );
        return err!(ErrorCode::InvalidCanopySize);
    }
    // 1 is subtracted from the trailing zeros because the root is not stored in the canopy
    Ok(closest_power_of_2.trailing_zeros() - 1)
}
